// Serves one connector file by its signed link. The link is checked first (signature, then expiry); only then is the row read and the bytes
// fetched from storage. The answer is the stored bytes with their stored media type, marked as an attachment and never sniffed.
import type { Sql } from "../learning/store.ts";
import { linkSecretFrom, meridianMcpFileStore, storedFileFor, verifyFileLink, type McpFileStore } from "./files.ts";

const text = (status: number, message: string) => new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function serveMcpFile(
  request: Request,
  fileId: string,
  deps: { getSql: () => Promise<Sql>; env: Record<string, string | undefined>; store?: (sql: Sql) => Promise<McpFileStore>; nowSeconds?: number },
): Promise<Response> {
  const secret = linkSecretFrom(deps.env);
  if (!secret) return text(503, "File links are not set up on this server.");
  const url = new URL(request.url);
  const check = verifyFileLink({ fileId, expires: url.searchParams.get("expires"), sig: url.searchParams.get("sig"), secret, nowSeconds: deps.nowSeconds ?? Math.floor(Date.now() / 1000) });
  if (check === "expired") return text(410, "This link has expired. Ask for a fresh one (meridian_files).");
  if (check !== "ok") return text(403, "This link is not valid.");
  const sql = await deps.getSql();
  const row = await storedFileFor(sql, fileId);
  if (!row) return text(404, "No such file.");
  const store = await (deps.store ?? meridianMcpFileStore)(sql);
  const bytes = await store.get({ organizationId: row.organizationId, brandId: row.brandId, key: row.key }).catch(() => null);
  if (!bytes) return text(404, "The file could not be read from storage.");
  const extension = row.key.split(".").pop() ?? "bin";
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": row.mediaType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${fileId}.${extension}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=600",
    },
  });
}
