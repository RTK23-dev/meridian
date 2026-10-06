import { PNG } from "pngjs";

export type VideoInspection = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: "mp4" | "unknown";
  frames: Uint8Array[];
};

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const IEND = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

/** Reads only boxes and embedded images. Missing fields stay null. */
export function inspectVideo(bytes: Uint8Array): VideoInspection {
  const found: VideoInspection = {
    durationMs: null,
    width: null,
    height: null,
    codec: null,
    container: "unknown",
    frames: extractPngs(bytes, 3),
  };
  if (bytes.byteLength < 16) return found;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  walk(view, bytes, 0, bytes.byteLength, 0, found);
  return found;
}

export function solidFrame(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data[index * 4] = rgb[0];
    png.data[index * 4 + 1] = rgb[1];
    png.data[index * 4 + 2] = rgb[2];
    png.data[index * 4 + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** A small MP4-shaped fixture with real mvhd, tkhd, and PNG frames. Not a camera recording. */
export function buildFixtureClip(input: {
  durationMs: number;
  width: number;
  height: number;
  frames: Uint8Array[];
}): Uint8Array {
  const timescale = 1000;
  const mvhd = new Uint8Array(100);
  const mvhdView = new DataView(mvhd.buffer);
  mvhdView.setUint32(12, timescale);
  mvhdView.setUint32(16, Math.max(0, Math.round(input.durationMs)));
  const tkhd = new Uint8Array(84);
  const tkhdView = new DataView(tkhd.buffer);
  tkhdView.setUint32(12, 1);
  tkhdView.setUint32(20, Math.max(0, Math.round(input.durationMs)));
  tkhdView.setUint32(76, Math.max(0, input.width) * 65536);
  tkhdView.setUint32(80, Math.max(0, input.height) * 65536);
  const moov = box("moov", concat(box("mvhd", mvhd), box("trak", box("tkhd", tkhd))));
  const free = box("free", concat(...input.frames));
  return concat(moov, free);
}

/** Scene text describes only what the bytes contain. It is not a transcript. */
export function videoFactsFromInspection(inspected: VideoInspection, byteSize: number): {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  transcript: "";
  scene: string;
} {
  const scene = inspected.frames.length
    ? `Container ${inspected.container}. ${inspected.frames.length} embedded frame(s) stored for vision${inspected.width && inspected.height ? `, ${inspected.width}×${inspected.height}` : ""}. No speech track was read.`
    : byteSize > 0
      ? `Container ${inspected.container}. ${byteSize} bytes stored. No sampled frame could be extracted, so vision was not run.`
      : "No video bytes were stored.";
  return {
    durationMs: inspected.durationMs,
    width: inspected.width,
    height: inspected.height,
    codec: inspected.codec,
    transcript: "",
    scene,
  };
}

function walk(view: DataView, bytes: Uint8Array, start: number, end: number, depth: number, found: VideoInspection): void {
  if (depth > 6) return;
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = text(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = view.getUint32(offset + 12);
      header = 16;
    }
    if (size < header || offset + size > end) return;
    if (type === "ftyp" || type === "moov" || type === "mvhd") found.container = "mp4";
    if (type === "mvhd") {
      const timing = readMvhd(view, offset + header, offset + size);
      if (timing) found.durationMs = timing;
    }
    if (type === "tkhd") readTkhd(view, offset + header, offset + size, found);
    if (type === "stsd") {
      const codec = readCodec(bytes, offset + header, offset + size);
      if (codec) found.codec = codec;
    }
    if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
      walk(view, bytes, offset + header, offset + size, depth + 1, found);
    }
    offset += size;
  }
}

function readMvhd(view: DataView, start: number, end: number): number | null {
  if (start + 20 > end) return null;
  const version = view.getUint8(start);
  const timescaleAt = version === 0 ? 12 : 20;
  const durationAt = version === 0 ? 16 : 28;
  if (start + durationAt + 4 > end) return null;
  const timescale = view.getUint32(start + timescaleAt);
  const duration = view.getUint32(start + durationAt);
  if (timescale <= 0) return null;
  return Math.round((duration / timescale) * 1000);
}

function readTkhd(view: DataView, start: number, end: number, found: VideoInspection): void {
  if (start + 84 > end) return;
  const version = view.getUint8(start);
  const widthAt = version === 0 ? 76 : 88;
  if (start + widthAt + 8 > end) return;
  const width = view.getUint32(start + widthAt) / 65536;
  const height = view.getUint32(start + widthAt + 4) / 65536;
  if (width > 0 && width < 10000) found.width = Math.round(width);
  if (height > 0 && height < 10000) found.height = Math.round(height);
  found.container = "mp4";
}

function readCodec(bytes: Uint8Array, start: number, end: number): string | null {
  if (start + 16 > end) return null;
  const entry = start + 8;
  if (entry + 4 > end) return null;
  const codec = text(bytes, entry, 4);
  return /^[a-z0-9]{4}$/i.test(codec) ? codec : null;
}

function extractPngs(bytes: Uint8Array, limit: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let index = 0; index + PNG_SIG.length < bytes.length && frames.length < limit; index += 1) {
    if (!matchAt(bytes, index, PNG_SIG)) continue;
    const end = indexOfSequence(bytes, IEND, index + PNG_SIG.length);
    if (end < 0) break;
    frames.push(bytes.slice(index, end + IEND.length));
    index = end + IEND.length - 1;
  }
  return frames;
}

function indexOfSequence(bytes: Uint8Array, sequence: number[], from: number): number {
  for (let index = from; index + sequence.length <= bytes.length; index += 1) {
    if (matchAt(bytes, index, sequence)) return index;
  }
  return -1;
}

function matchAt(bytes: Uint8Array, index: number, sequence: number[]): boolean {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (bytes[index + offset] !== sequence[offset]) return false;
  }
  return true;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[start + index] ?? 0);
  return value;
}
