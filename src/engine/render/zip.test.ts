// The archive writer: a round trip through an independent reader, determinism, and the path rules.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { EngineError } from "../contracts/index.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

/** A minimal reader that parses the central directory and checks each entry's CRC. It reads only what buildZip writes. */
function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, "end of central directory");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "central header");
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local header");
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(data.length, size, `size of ${name}`);
    assert.equal(crc32(data), checksum, `crc of ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength;
  }
  return entries;
}

const text = (value: string) => new TextEncoder().encode(value);

describe("buildZip", () => {
  it("round-trips text, binary, empty and compressible entries", () => {
    const random = new Uint8Array(4096);
    for (let i = 0; i < random.length; i++) {
      random[i] = (i * 2654435761) & 0xff;
    }
    const entries: ZipEntry[] = [
      { path: "index.html", bytes: text("<!DOCTYPE html>".repeat(200)) },
      { path: "assets/noise.bin", bytes: random },
      { path: "empty.txt", bytes: new Uint8Array(0) },
      { path: "components/ünïcode.html", bytes: text("ok") },
    ];
    const entriesRead = readZip(buildZip(entries));
    assert.equal(entriesRead.size, entries.length);
    for (const entry of entries) {
      assert.deepEqual(entriesRead.get(entry.path), Buffer.from(entry.bytes), entry.path);
    }
  });

  it("is deterministic: the same entries give the same bytes, whatever their order", () => {
    const a: ZipEntry = { path: "a.txt", bytes: text("alpha") };
    const b: ZipEntry = { path: "b/b.txt", bytes: text("beta") };
    const forward = buildZip([a, b]);
    const backward = buildZip([b, a]);
    assert.deepEqual(forward, backward);
    assert.deepEqual(buildZip([a, b]), forward);
  });

  it("refuses paths that escape the archive or are not relative", () => {
    for (const path of ["../escape.txt", "/absolute.txt", "dir\\file.txt", "a/../b.txt", ""]) {
      assert.throws(
        () => buildZip([{ path, bytes: text("x") }]),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
        `path ${JSON.stringify(path)} should be refused`,
      );
    }
  });

  it("refuses duplicate paths and an empty archive", () => {
    assert.throws(() => buildZip([{ path: "a", bytes: text("1") }, { path: "a", bytes: text("2") }]), /appears twice/);
    assert.throws(() => buildZip([]), /between 1 and/);
  });
});
