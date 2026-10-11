import type { ChatProvider, ChatRequest, ChatResult } from "@/lib/meridian/providers/types";
import { resolveDeploymentOnlyKey } from "../credentials/resolve.ts";
import type { CredentialResolution } from "../credentials/contract.ts";

function key(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * The OpenRouter key for the chat path. The path runs for the whole deployment, with no workspace in scope, so the key is
 * read only through the credential resolver and only when OPENROUTER_SHARED_DEFAULT=deployment is set. A deployment that has
 * not opted in gets no chat provider, and nothing is sent.
 */
export function openRouterChatCredential(): CredentialResolution {
  return resolveDeploymentOnlyKey("openrouter_chat", process.env);
}

function chatKey(): string | undefined {
  const resolution = openRouterChatCredential();
  return resolution.status === "ready" ? resolution.secret : undefined;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function postChat(
  provider: string,
  url: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  request: ChatRequest,
  user: string | ContentPart[],
): Promise<ChatResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(25_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) {
      return { ok: false, status: "failed", provider, error: `${provider} returned ${response.status}.` };
    }
    const body = (await response.json()) as {
      usage?: { total_tokens?: number };
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return { ok: false, status: "failed", provider, error: `${provider} returned an empty response.` };
    }
    return {
      ok: true,
      content,
      latencyMs: Date.now() - started,
      tokens: typeof body.usage?.total_tokens === "number" ? body.usage.total_tokens : null,
      provider,
      model: request.model,
    };
  } catch {
    return { ok: false, status: "failed", provider, error: `${provider} could not be reached.` };
  }
}

export const openRouterProvider: ChatProvider = {
  id: "openrouter",
  configured: () => Boolean(chatKey() && key("OPENROUTER_MODEL")),
  complete: (request) => {
    const apiKey = chatKey();
    if (!apiKey || !key("OPENROUTER_MODEL")) {
      return Promise.resolve({ ok: false, status: "unavailable", provider: "openrouter", error: "OpenRouter chat needs OPENROUTER_SHARED_DEFAULT=deployment, OPENROUTER_API_KEY and OPENROUTER_MODEL." });
    }
    return postChat("openrouter", "https://openrouter.ai/api/v1/chat/completions", apiKey, {}, request, request.user);
  },
};

/** OpenRouter is the sole external model gateway for JEV and vision tasks. */
export function activeChatProvider(): ChatProvider | null {
  if (openRouterProvider.configured()) return openRouterProvider;
  return null;
}

export function providerStatus(): { configured: boolean; provider: string; model: string } {
  const provider = activeChatProvider();
  if (!provider) return { configured: false, provider: "none", model: "" };
  const model = key("OPENROUTER_MODEL") || "";
  return { configured: true, provider: provider.id, model };
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The model did not return JSON.");
  }
}

/** Vision-capable completion. The image URL is untrusted data, never a system instruction. */
export async function completeWithImage(request: {
  system: string;
  text: string;
  imageUrl: string;
  maxTokens: number;
}): Promise<ChatResult> {
  const provider = activeChatProvider();
  const status = providerStatus();
  if (!provider) {
    return { ok: false, status: "unavailable", provider: "none", error: "No vision model is configured." };
  }
  const payload: ChatRequest = {
    model: status.model,
    temperature: 0,
    maxTokens: request.maxTokens,
    system: request.system,
    user: request.text,
  };
  const parts: ContentPart[] = [
    { type: "text", text: request.text },
    { type: "image_url", image_url: { url: request.imageUrl } },
  ];
  const apiKey = chatKey();
  if (!apiKey) return { ok: false, status: "unavailable", provider: "openrouter", error: "No vision model is configured." };
  return postChat("openrouter", "https://openrouter.ai/api/v1/chat/completions", apiKey, {}, payload, parts);
}
