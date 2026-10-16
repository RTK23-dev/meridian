// Recorded HTTP responses of the media functions. The "captured" entries are the exact responses of
// functions/ffmpeg/http.ts (handleMediaRequest) run in-process on the test reel on 2026-10-14, with ffmpeg 6.1.1. The
// "synthetic" entries are written by hand: the platform's rate-limit and gateway-timeout replies are not known until the
// function is deployed, so they stand in for them. Do not edit captured bodies by hand.

export type RecordedHttpResponse = { status: number; body: string };

/** captured: probe of the test reel. */
export const CAPTURED_PROBE_200: RecordedHttpResponse = {
  status: 200,
  body: '{"container":"mov,mp4,m4a,3gp,3g2,mj2","videoCodec":"h264","audioCodec":"aac","width":1080,"height":1920,"fps":{"num":30,"den":1,"value":30},"durationMs":3000,"audioPresent":true,"bytes":346808}',
};

/** captured: cuts of the test reel at scene score 0.3. */
export const CAPTURED_CUTS_200: RecordedHttpResponse = {
  status: 200,
  body: '{"cutsMs":[1000,2000]}',
};

/** captured: loudness of the test reel (its audio is a 1 kHz sine). */
export const CAPTURED_LOUDNESS_200: RecordedHttpResponse = {
  status: 200,
  body: '{"integratedLufs":-21.1,"truePeakDbtp":-16.9,"loudnessRangeLu":20}',
};

/** captured: one frame at 1500 ms, long side 768 px (432 x 768). */
export const CAPTURED_FRAMES_200: RecordedHttpResponse = {
  status: 200,
  body: '{"frames":[{"atMs":1500,"width":432,"height":768,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAbAAAAMACAIAAADKeaUhAAAACXBIWXMAAAABAAAAAQBPJcTWAAAI5klEQVR4nO3XwQkCMRBA0VSyHck2rGBp6vIVtoAlSB68y5wyp09mbPsDgLex7ffD/FUA5hqn+fb8mL0TwBS/IB7/REEEFja+EXQ4A6s7n8yyCCxsXP0AwL8QRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSACCJABBEggggQQQSIIAJEEAEiiAARRIAIIkAEESCCCBBBBIggAkQQASKIABFEgAgiQAQRIIIIEEEEiCACRBABIogAEUSAvACdbPhbgxOPnAAAAABJRU5ErkJggg=="}]}',
};

/** captured: a plain-http URL, refused by the default policy. */
export const CAPTURED_URL_NOT_ALLOWED_400: RecordedHttpResponse = {
  status: 400,
  body: '{"error":{"kind":"invalid_input","retryable":false,"message":"the media URL is not allowed by this function\'s URL policy","stage":"media.source"}}',
};

/** captured: a request body that is not JSON. */
export const CAPTURED_BAD_JSON_400: RecordedHttpResponse = {
  status: 400,
  body: '{"error":{"kind":"invalid_input","retryable":false,"message":"the request body is not JSON","stage":"media.http"}}',
};

/** captured: a path with no media function. */
export const CAPTURED_UNKNOWN_ROUTE_404: RecordedHttpResponse = {
  status: 404,
  body: '{"error":{"kind":"not_found","retryable":false,"message":"no media function at /nope","stage":null}}',
};

/** captured: GET on a POST-only function. */
export const CAPTURED_WRONG_METHOD_405: RecordedHttpResponse = {
  status: 405,
  body: '{"error":{"kind":"invalid_input","retryable":false,"message":"use POST","stage":null}}',
};

/** captured: a frame time at 2999 ms, past the last frame. */
export const CAPTURED_BEYOND_END_400: RecordedHttpResponse = {
  status: 400,
  body: '{"error":{"kind":"invalid_input","retryable":false,"message":"no decodable frame at 2999 ms: the time is at or past the last frame of the media","stage":"media.frames"}}',
};

/** synthetic: a rate-limit reply in the shape the handler uses for a retryable provider error. */
export const SYNTHETIC_RATE_LIMIT_429: RecordedHttpResponse = {
  status: 429,
  body: '{"error":{"kind":"provider","retryable":true,"message":"rate limited; retry later"}}',
};

/** synthetic: a gateway timeout from the platform in front of the function, with no JSON body. */
export const SYNTHETIC_GATEWAY_TIMEOUT_504: RecordedHttpResponse = {
  status: 504,
  body: "gateway timeout",
};
