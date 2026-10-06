import { createHash, createHmac } from "node:crypto";
import { safeStorageKey } from "./object-store.ts";

export type S3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.S3_ENDPOINT?.trim() ?? "";
  const bucket = env.S3_BUCKET?.trim() ?? "";
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.S3_REGION?.trim() || "us-east-1" };
}

export function s3ConnectionState(env: NodeJS.ProcessEnv = process.env): {
  status: "NOT_CONNECTED" | "CONFIGURED";
  detail: string;
} {
  if (!s3ConfigFromEnv(env)) {
    return {
      status: "NOT_CONNECTED",
      detail: "No S3-compatible endpoint is configured. Development bytes use the local filesystem. Nothing is sent to a bucket.",
    };
  }
  return {
    status: "CONFIGURED",
    detail: "S3 credentials are present. An object is stored only after the bucket accepts the request.",
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function amzDate(now: Date): { short: string; long: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { short: iso.slice(0, 8), long: iso };
}

function encodePath(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function signS3Request(config: S3Config, input: {
  method: "PUT" | "GET" | "DELETE" | "HEAD";
  key: string;
  now?: Date;
  payload?: Uint8Array;
  expires?: number;
}): { url: string; headers: Record<string, string> } {
  const now = input.now ?? new Date();
  const dates = amzDate(now);
  const region = config.region || "us-east-1";
  const endpoint = new URL(config.endpoint);
  const key = safeStorageKey(input.key);
  const canonicalUri = `/${config.bucket}/${encodePath(key)}`;
  const payload = input.payload ?? new Uint8Array();
  const payloadHash = input.method === "GET" || input.method === "DELETE" || input.method === "HEAD" ? "UNSIGNED-PAYLOAD" : sha256(payload);
  const host = endpoint.host;
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": dates.long,
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonical = [input.method, canonicalUri, "", canonicalHeaders, signed.join(";"), payloadHash].join("\n");
  const scope = `${dates.short}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dates.long, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dates.short), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
  return { url: `${endpoint.origin}${canonicalUri}`, headers };
}

export function createS3ObjectStore(config: S3Config, fetchImpl: typeof fetch = fetch) {
  return {
    id: "s3" as const,
    async put(key: string, bytes: Uint8Array, mimeType: string): Promise<{ checksum: string; size: number }> {
      const signed = signS3Request(config, { method: "PUT", key, payload: bytes });
      const response = await fetchImpl(signed.url, {
        method: "PUT",
        headers: { ...signed.headers, "content-type": mimeType },
        body: Buffer.from(bytes),
      });
      if (!response.ok) throw new Error(`S3 put failed (${response.status}). The object was not stored.`);
      return { checksum: sha256(bytes), size: bytes.byteLength };
    },
    async get(key: string): Promise<Uint8Array | null> {
      const signed = signS3Request(config, { method: "GET", key });
      const response = await fetchImpl(signed.url, { method: "GET", headers: signed.headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`S3 get failed (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(key: string): Promise<void> {
      const signed = signS3Request(config, { method: "DELETE", key });
      const response = await fetchImpl(signed.url, { method: "DELETE", headers: signed.headers });
      if (!response.ok && response.status !== 404) throw new Error(`S3 delete failed (${response.status}).`);
    },
    async exists(key: string): Promise<boolean> {
      const signed = signS3Request(config, { method: "HEAD", key });
      const response = await fetchImpl(signed.url, { method: "HEAD", headers: signed.headers });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`S3 head failed (${response.status}).`);
      return true;
    },
    signedUrl(key: string, now = new Date()): string {
      return signS3Request(config, { method: "GET", key, now }).url;
    },
  };
}
