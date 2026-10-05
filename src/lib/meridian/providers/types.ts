export type ChatRequest = {
  model: string;
  temperature: number;
  maxTokens: number;
  system: string;
  user: string;
};

export type ChatResult =
  | { ok: true; content: string; latencyMs: number; tokens: number | null; provider: string; model: string }
  | { ok: false; error: string; status: "unavailable" | "failed"; provider: string };

export type ChatProvider = {
  id: "xai" | "openrouter";
  configured(): boolean;
  complete(request: ChatRequest): Promise<ChatResult>;
};
