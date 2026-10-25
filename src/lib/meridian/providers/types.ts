/**
 * One text-generation answer as the research analysis reads it. The provenance fields are set by the generation path (chat.server.ts):
 * the model OpenRouter says answered, the generation id and the cost it reported. A null cost means none was reported.
 */
export type ChatResult =
  | {
      ok: true;
      content: string;
      latencyMs: number;
      tokens: number | null;
      provider: string;
      model: string;
      returnedModel?: string | null;
      generationId?: string | null;
      costUsd?: number | null;
    }
  | { ok: false; error: string; status: "unavailable" | "failed"; provider: string };
