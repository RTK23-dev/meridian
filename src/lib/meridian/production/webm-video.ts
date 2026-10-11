/**
 * WebM container check for postflight.
 *
 * A WebM file is an EBML document. Its header declares the `webm` DocType, and its Segment holds a Tracks element whose
 * TrackEntry of TrackType 1 is a video track. This reads only element headers and the TrackType and DocType values. It
 * never decodes media. A Matroska (MKV) file, an audio-only WebM, or a malformed or truncated file reads as "no video
 * track", so it fails closed.
 */

const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_DOC_TYPE_ID = 0x4282;
const SEGMENT_ID = 0x18538067;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_TYPE_ID = 0x83;
const TRACK_TYPE_VIDEO = 1;

type EbmlElement = { id: number; dataStart: number; dataEnd: number };

/** The length in bytes of an EBML variable-length integer whose first byte is `first`, or 0 when `first` cannot start one. */
function vintLength(first: number): number {
  for (let length = 1; length <= 8; length += 1) {
    if (first & (0x100 >> length)) return length;
  }
  return 0;
}

/**
 * Reads the element header at `offset` within `[offset, end)`. Returns null when the header is malformed, truncated, or its
 * data runs past `end`. An unknown size (all value bits set) runs to `end`, as a live stream's Segment or Cluster does.
 */
function readElement(bytes: Uint8Array, offset: number, end: number): EbmlElement | null {
  if (offset >= end) return null;
  const idLength = vintLength(bytes[offset]);
  if (idLength === 0 || idLength > 4 || offset + idLength >= end) return null;
  let id = 0;
  for (let index = 0; index < idLength; index += 1) id = id * 256 + bytes[offset + index];

  const sizeAt = offset + idLength;
  const sizeLength = vintLength(bytes[sizeAt]);
  if (sizeLength === 0 || sizeAt + sizeLength > end) return null;
  const marker = 0xff >> sizeLength;
  let size = bytes[sizeAt] & marker;
  let unknown = size === marker;
  for (let index = 1; index < sizeLength; index += 1) {
    const byte = bytes[sizeAt + index];
    size = size * 256 + byte;
    unknown = unknown && byte === 0xff;
  }

  const dataStart = sizeAt + sizeLength;
  if (unknown) return { id, dataStart, dataEnd: end };
  const dataEnd = dataStart + size;
  return dataEnd <= end ? { id, dataStart, dataEnd } : null;
}

/** Every direct child with `id` in `[start, end)`. Scanning stops at the first header that cannot be read. */
function childrenWithId(bytes: Uint8Array, start: number, end: number, id: number): EbmlElement[] {
  const found: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const element = readElement(bytes, offset, end);
    if (!element) break;
    if (element.id === id) found.push(element);
    offset = element.dataEnd;
  }
  return found;
}

/** An unsigned integer element's value, read big-endian. Element data of more than 8 bytes is not an integer here. */
function unsignedValue(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.dataEnd - element.dataStart;
  if (length < 1 || length > 8) return null;
  let value = 0;
  for (let index = element.dataStart; index < element.dataEnd; index += 1) value = value * 256 + bytes[index];
  return value;
}

/** True when the element's string value is exactly `text`, ignoring the zero padding EBML strings may carry. */
function isAsciiValue(bytes: Uint8Array, element: EbmlElement, text: string): boolean {
  let end = element.dataEnd;
  while (end > element.dataStart && bytes[end - 1] === 0) end -= 1;
  if (end - element.dataStart !== text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[element.dataStart + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * True when the bytes are a WebM file that declares a video track: a `webm` EBML header, and a Segment whose Tracks hold a
 * TrackEntry with TrackType 1. Anything else, including Matroska, an audio-only file, or a truncated file, is false.
 */
export function isWebmWithVideoTrack(bytes: Uint8Array): boolean {
  const header = readElement(bytes, 0, bytes.byteLength);
  if (!header || header.id !== EBML_HEADER_ID) return false;

  const docTypes = childrenWithId(bytes, header.dataStart, header.dataEnd, EBML_DOC_TYPE_ID);
  if (docTypes.length !== 1 || !isAsciiValue(bytes, docTypes[0], "webm")) return false;

  for (const segment of childrenWithId(bytes, header.dataEnd, bytes.byteLength, SEGMENT_ID)) {
    for (const tracks of childrenWithId(bytes, segment.dataStart, segment.dataEnd, TRACKS_ID)) {
      for (const entry of childrenWithId(bytes, tracks.dataStart, tracks.dataEnd, TRACK_ENTRY_ID)) {
        const types = childrenWithId(bytes, entry.dataStart, entry.dataEnd, TRACK_TYPE_ID);
        if (types.some((type) => unsignedValue(bytes, type) === TRACK_TYPE_VIDEO)) return true;
      }
    }
  }
  return false;
}
