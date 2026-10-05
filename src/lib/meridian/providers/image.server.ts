function key(): string | undefined {
  const value = process.env.XAI_API_KEY?.trim();
  return value || undefined;
}

export async function generateImage(
  prompt: string,
): Promise<
  | { ok: true; url: string; latencyMs: number }
  | { ok: false; error: string; status: "unavailable" | "failed" }
> {
  const apiKey = key();
  if (!apiKey) return { ok: false, status: "unavailable", error: "Image generation is not configured." };
  const started = Date.now();
  try {
    const response = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      signal: AbortSignal.timeout(40_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt: prompt.slice(0, 2000),
        n: 1,
        response_format: "url",
      }),
    });
    if (!response.ok) return { ok: false, status: "failed", error: `Image generation returned ${response.status}.` };
    const body = (await response.json()) as { data?: { url?: string }[] };
    const url = body.data?.[0]?.url ?? "";
    if (!url.startsWith("https://")) return { ok: false, status: "failed", error: "Image generation did not return a URL." };
    return { ok: true, url, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, status: "failed", error: "Image generation could not be reached." };
  }
}
