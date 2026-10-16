// Deterministic ZIP archive for the HyperFrames cloud upload (Bible 6.11, 9.1 rule 7). The bytes depend only on the
// entries: names are sorted, timestamps are fixed to 1980-01-01, attributes are fixed, and zlib's deflate is
// deterministic for the same input. So the upload checksum is stable across runs and machines of one zlib version.

import { crc32, deflateRawSync } from "node:zlib";
import { EngineError } from "../contracts/index.ts";

export type ZipEntry = { path: string; bytes: Uint8Array };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 1980-01-01 00:00:00 in MS-DOS format. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Regular file with rw-r--r-- permissions in the high 16 bits of the external attributes. */
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const ZIP32_LIMIT = 0xffffffff;
const ENTRY_LIMIT = 0xffff;

function refuse(message: string): never {
  throw new EngineError("invalid_input", message, { stage: "render" });
}

function checkPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    refuse(`archive path "${path}" must be relative, with / separators and no ..`);
  }
}

/** Build a ZIP archive from entries. Throws invalid_input for duplicate, unsafe or oversized entries. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length === 0 || entries.length > ENTRY_LIMIT) {
    refuse(`an archive needs between 1 and ${ENTRY_LIMIT} entries`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    checkPath(entry.path);
    if (seen.has(entry.path)) {
      refuse(`archive path "${entry.path}" appears twice`);
    }
    seen.add(entry.path);
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.bytes);
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? METHOD_DEFLATE : METHOD_STORE;
    const payload = method === METHOD_DEFLATE ? deflated : data;
    if (offset + 30 + name.length + payload.length > ZIP32_LIMIT) {
      refuse("archive exceeds the ZIP32 size limit");
    }
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(FLAG_UTF8_NAMES, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(UNIX_FILE_ATTRIBUTES, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + payload.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  if (offset > ZIP32_LIMIT || centralSize > ZIP32_LIMIT) {
    refuse("archive exceeds the ZIP32 size limit");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}
