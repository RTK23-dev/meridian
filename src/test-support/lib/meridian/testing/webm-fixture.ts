/**
 * A small WebM byte fixture for container tests: an EBML header with a DocType, a Segment with a Tracks element, and one
 * Cluster. No media is encoded anywhere; the Cluster payload is a placeholder. A Segment of unknown size is written the way a
 * live stream writes it.
 */

export type WebmTrack = { number: number; type: number; codec: string };

/** The WebM TrackType for video. Audio is 2. */
export const WEBM_TRACK_VIDEO: WebmTrack = { number: 1, type: 1, codec: "V_VP9" };
export const WEBM_TRACK_AUDIO: WebmTrack = { number: 2, type: 2, codec: "A_OPUS" };

/** An EBML element: its ID bytes, an 8-byte size, then the payload. Every size here fits the 8-byte form. */
function element(id: number[], ...payload: number[][]): number[] {
  const body = payload.flat();
  const size = body.length;
  return [...id, 0x01, 0, 0, 0, 0, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...body];
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function trackEntry(track: WebmTrack): number[] {
  return element([0xae], element([0xd7], [track.number]), element([0x83], [track.type]), element([0x86], ascii(track.codec)));
}

export function webmFixture(options: { docType?: string; tracks: WebmTrack[]; unknownSegmentSize?: boolean }): Uint8Array {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x86], [1]), element([0x42, 0x82], ascii(options.docType ?? "webm")));
  const tracks = element([0x16, 0x54, 0xae, 0x6b], ...options.tracks.map(trackEntry));
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0]), element([0xa3], [0x81, 0, 0, 0x80, 1, 2, 3]));
  const segmentBody = [...tracks, ...cluster];
  const segment = options.unknownSegmentSize
    ? [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...segmentBody]
    : element([0x18, 0x53, 0x80, 0x67], segmentBody);
  return Uint8Array.from([...header, ...segment]);
}
