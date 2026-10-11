/**
 * Google Drive REST Client & Primary Storage
 *
 * Primary binary object store for Meridian.
 * Organizes files by tenant and brand hierarchy.
 * Never fabricates file states when disconnected.
 */

import { createHash } from "node:crypto";
import { getGoogleDriveAccessToken, getGoogleDriveAuthStatus } from "./google-auth.ts";

export type DriveFileMetadata = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  checksum: string;
  webViewLink?: string;
};

export type DriveHealth = {
  status: "HEALTHY" | "NOT_CONFIGURED" | "UNAVAILABLE";
  detail: string;
  latencyMs: number;
};

/** The earliest-created folder, ties broken by id, so every process picks the same one. */
export function pickEarliest(folders: Array<{ id: string; createdTime?: string }>): string {
  const sorted = [...folders].sort((a, b) => {
    const left = a.createdTime ?? "";
    const right = b.createdTime ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0]!.id;
}

export class GoogleDriveClient {
  private folderCache = new Map<string, string>();

  private getRootFolderId(): string | undefined {
    return process.env.MERIDIAN_DRIVE_FOLDER_ID?.trim();
  }

  async health(): Promise<DriveHealth> {
    const authStatus = getGoogleDriveAuthStatus();
    if (!authStatus.configured) {
      return {
        status: "NOT_CONFIGURED",
        detail: authStatus.detail,
        latencyMs: 0,
      };
    }

    const token = await getGoogleDriveAccessToken();
    if (!token) {
      return {
        status: "UNAVAILABLE",
        detail: "Failed to acquire Google Drive access token.",
        latencyMs: 0,
      };
    }

    const started = Date.now();
    try {
      const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user,storageQuota", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return {
          status: "UNAVAILABLE",
          detail: `Drive API returned HTTP ${res.status}: ${await res.text()}`,
          latencyMs: Date.now() - started,
        };
      }
      return {
        status: "HEALTHY",
        detail: "Connected to Google Drive API.",
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        status: "UNAVAILABLE",
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  /**
   * Finds a folder by name under a parent, or creates it. Concurrent calls in this process share one lookup, and when
   * several folders share a name (possible when two processes create one at the same time), every caller settles on the
   * earliest-created one, so they converge without a lock in Drive.
   */
  async findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const cacheKey = `${parentId || "root"}:${name}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.folderInflight.get(cacheKey);
    if (pending) return pending;
    const work = this.resolveFolder(name, parentId, cacheKey).finally(() => {
      this.folderInflight.delete(cacheKey);
    });
    this.folderInflight.set(cacheKey, work);
    return work;
  }

  private folderInflight = new Map<string, Promise<string>>();

  private async listFolders(token: string, name: string, parentId?: string): Promise<Array<{ id: string; createdTime?: string }>> {
    const qParts = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ];
    if (parentId) {
      qParts.push(`'${parentId}' in parents`);
    }
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      qParts.join(" and "),
    )}&fields=files(id,name,createdTime)`;
    const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: Array<{ id: string; createdTime?: string }> };
    return data.files ?? [];
  }

  private async resolveFolder(name: string, parentId: string | undefined, cacheKey: string): Promise<string> {
    const token = await getGoogleDriveAccessToken();
    if (!token) throw new Error("Google Drive is not configured. Access token unavailable.");

    const existing = await this.listFolders(token, name, parentId);
    if (existing.length > 0) {
      const earliest = pickEarliest(existing);
      this.folderCache.set(cacheKey, earliest);
      return earliest;
    }

    const body: { name: string; mimeType: string; parents?: string[] } = {
      name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) {
      body.parents = [parentId];
    }

    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create Drive folder '${name}': ${await createRes.text()}`);
    }

    const created = (await createRes.json()) as { id: string };
    // Another process may have created the same folder at the same moment. Settle on the earliest one.
    const afterCreate = await this.listFolders(token, name, parentId);
    // The re-read includes the folder we just created, with its createdTime. Fall back to it only if the re-read is empty.
    const winner = afterCreate.length > 0 ? pickEarliest(afterCreate) : created.id;
    this.folderCache.set(cacheKey, winner);
    return winner;
  }

  async getFolderForPath(input: {
    organizationId: string;
    brandId: string;
    subpath: string;
  }): Promise<string> {
    const rootId = this.getRootFolderId();
    const tenantsFolder = await this.findOrCreateFolder("tenants", rootId);
    const orgFolder = await this.findOrCreateFolder(input.organizationId, tenantsFolder);
    const brandsFolder = await this.findOrCreateFolder("brands", orgFolder);
    const brandFolder = await this.findOrCreateFolder(input.brandId, brandsFolder);

    const segments = input.subpath.split("/").filter(Boolean);
    let currentFolderId = brandFolder;
    for (const segment of segments) {
      currentFolderId = await this.findOrCreateFolder(segment, currentFolderId);
    }
    return currentFolderId;
  }

  async put(input: {
    organizationId: string;
    brandId: string;
    path: string;
    mimeType: string;
    bytes: Uint8Array;
    metadata?: Record<string, unknown>;
  }): Promise<DriveFileMetadata> {
    const token = await getGoogleDriveAccessToken();
    if (!token) throw new Error("Google Drive is not configured. Binary upload cannot proceed.");

    const pathParts = input.path.split("/").filter(Boolean);
    const fileName = pathParts.pop() || "unnamed_artifact";
    const subpath = pathParts.join("/");

    const parentFolderId = await this.getFolderForPath({
      organizationId: input.organizationId,
      brandId: input.brandId,
      subpath,
    });

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storageKeyHash = createHash("sha256").update(input.path).digest("hex");
    const existingQuery = [
      `'${parentFolderId}' in parents`,
      `appProperties has { key='meridian_storage_key_hash' and value='${storageKeyHash}' }`,
      "trashed = false",
    ].join(" and ");
    const existingRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(existingQuery)}&fields=files(id,name,mimeType,size,appProperties,webViewLink)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!existingRes.ok) {
      throw new Error(`Google Drive upload reconciliation failed (${existingRes.status}): ${await existingRes.text()}`);
    }
    const existingData = (await existingRes.json()) as {
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        webViewLink?: string;
        appProperties?: Record<string, string>;
      }>;
    };
    const existing = existingData.files?.[0];
    if (existing) {
      const properties = existing.appProperties || {};
      if (
        properties.organizationId !== input.organizationId ||
        properties.brandId !== input.brandId ||
        properties.sha256 !== sha256
      ) {
        throw new Error("Google Drive storage key already exists with different tenant ownership or content.");
      }
      const stored = await this.get(existing.id);
      const storedSha256 = createHash("sha256").update(stored.bytes).digest("hex");
      if (storedSha256 !== sha256 || stored.bytes.byteLength !== input.bytes.byteLength) {
        throw new Error("Google Drive existing object failed idempotent upload verification.");
      }
      return {
        fileId: existing.id,
        name: existing.name,
        mimeType: existing.mimeType || input.mimeType,
        size: existing.size ? Number(existing.size) : stored.bytes.byteLength,
        checksum: sha256,
        webViewLink: existing.webViewLink,
      };
    }

    const fileMetadata = {
      name: fileName,
      parents: [parentFolderId],
      properties: {
        sha256,
        organizationId: input.organizationId,
        brandId: input.brandId,
      },
      appProperties: {
        meridian_storage_key_hash: storageKeyHash,
        sha256,
        organizationId: input.organizationId,
        brandId: input.brandId,
      },
    };

    // Resumable upload for files larger than 5 MB
    const isLarge = input.bytes.byteLength > 5 * 1024 * 1024;
    if (isLarge) {
      const initRes = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": input.mimeType,
            "X-Upload-Content-Length": input.bytes.byteLength.toString(),
          },
          body: JSON.stringify(fileMetadata),
        },
      );

      if (!initRes.ok) {
        throw new Error(`Google Drive resumable upload init failed (${initRes.status}): ${await initRes.text()}`);
      }

      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) {
        throw new Error("Google Drive did not return resumable upload session URL.");
      }

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": input.bytes.byteLength.toString(),
          "Content-Type": input.mimeType,
        },
        body: Buffer.from(input.bytes),
      });

      if (!uploadRes.ok) {
        throw new Error(`Google Drive resumable content upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
      }

      const data = (await uploadRes.json()) as { id: string; name: string; mimeType: string; size?: string; webViewLink?: string };
      return {
        fileId: data.id,
        name: data.name,
        mimeType: data.mimeType || input.mimeType,
        size: data.size ? Number(data.size) : input.bytes.byteLength,
        checksum: sha256,
        webViewLink: data.webViewLink,
      };
    }

    // Multipart upload for <= 5 MB
    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataHeader = "Content-Type: application/json; charset=UTF-8\r\n\r\n";
    const mediaHeader = `Content-Type: ${input.mimeType}\r\n\r\n`;

    const metaPart = Buffer.from(delimiter + metadataHeader + JSON.stringify(fileMetadata) + delimiter + mediaHeader);
    const closePart = Buffer.from(closeDelimiter);
    const multipartBody = Buffer.concat([metaPart, Buffer.from(input.bytes), closePart]);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      },
    );

    if (!res.ok) {
      throw new Error(`Google Drive upload failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { id: string; name: string; mimeType: string; size?: string; webViewLink?: string };

    return {
      fileId: data.id,
      name: data.name,
      mimeType: data.mimeType || input.mimeType,
      size: data.size ? Number(data.size) : input.bytes.byteLength,
      checksum: sha256,
      webViewLink: data.webViewLink,
    };
  }

  async findFileByName(folderId: string, name: string): Promise<string | null> {
    const token = await getGoogleDriveAccessToken();
    if (!token) return null;
    const q = `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { files?: Array<{ id: string }> };
    return data.files?.[0]?.id || null;
  }

  async get(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string; name: string }> {
    const token = await getGoogleDriveAccessToken();
    if (!token) throw new Error("Google Drive is not configured. Cannot download file.");

    // First get metadata
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      throw new Error(`Failed to fetch Drive file metadata: ${await metaRes.text()}`);
    }
    const meta = (await metaRes.json()) as { name: string; mimeType: string };

    // Then download bytes
    const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!mediaRes.ok) {
      throw new Error(`Failed to download Drive file bytes: ${await mediaRes.text()}`);
    }

    const arrayBuffer = await mediaRes.arrayBuffer();
    return {
      bytes: new Uint8Array(arrayBuffer),
      mimeType: meta.mimeType || "application/octet-stream",
      name: meta.name || fileId,
    };
  }

  async delete(fileId: string): Promise<void> {
    const token = await getGoogleDriveAccessToken();
    if (!token) throw new Error("Google Drive is not configured.");

    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete Drive file: ${await res.text()}`);
    }
  }

  async exists(fileId: string): Promise<boolean> {
    const token = await getGoogleDriveAccessToken();
    if (!token) return false;

    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Scans production drop folder for outputs produced externally (ManualCloud mode).
   */
  /**
   * Creates (or finds) a job's output folder and returns its URL, so a person can see where to place the finished file.
   * Called at submit time, so the handoff location exists before anyone is asked to use it.
   */
  async ensureOutputFolder(input: { organizationId: string; brandId: string; jobId: string }): Promise<string> {
    const folderId = await this.getFolderForPath({
      organizationId: input.organizationId,
      brandId: input.brandId,
      subpath: `production/outputs/${input.jobId}`,
    });
    return `https://drive.google.com/drive/folders/${folderId}`;
  }

  async syncDropFolder(input: {
    organizationId: string;
    brandId: string;
    jobId: string;
  }): Promise<Array<{ fileId: string; name: string; mimeType: string; size: number; modifiedTime: string | null }>> {
    const token = await getGoogleDriveAccessToken();
    if (!token) return [];

    try {
      const folderId = await this.getFolderForPath({
        organizationId: input.organizationId,
        brandId: input.brandId,
        subpath: `production/outputs/${input.jobId}`,
      });

      const q = `'${folderId}' in parents and trashed = false`;
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) return [];
      const data = (await res.json()) as {
        files?: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }>;
      };
      if (!data.files) return [];

      return data.files.map((f) => ({
        fileId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size ? Number(f.size) : 0,
        modifiedTime: f.modifiedTime ?? null,
      }));
    } catch {
      return [];
    }
  }
}

export const googleDriveClient = new GoogleDriveClient();
