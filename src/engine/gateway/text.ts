// The media functions' transport speaks text bodies (media/wire-client.ts). This turns a gateway transport into that shape.

import type { HttpTransport } from "./types.ts";

export type TextTransport = (request: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<{ status: number; body: string }>;

export function textTransport(transport: HttpTransport): TextTransport {
  return async (request) => {
    const response = await transport(request);
    return { status: response.status, body: new TextDecoder().decode(response.body) };
  };
}
