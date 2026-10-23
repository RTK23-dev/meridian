// Models the engine no longer uses, each with the decision that retired it. The video catalog parser drops a listed model with one of
// these ids, so the chooser never offers it and no route or price names it. Add an entry only by owner decision, and say why.
//
// Veo 3.1 (Google, through OpenRouter): removed by the owner on 2026-10-23. The engine had named its preview models in the Bible's
// video classes (Bible 10.3), and Google shut the Veo 3.1 Preview models down in the Gemini API on 2026-10-22. The replacement is chosen
// from the live catalog (Bible 10.5); no model is named here in its place.

export const RETIRED_MODEL_IDS: Readonly<Record<string, string>> = {
  "google/veo-3.1": "retired by owner decision, 2026-10-23: Veo 3.1 is no longer used",
  "google/veo-3.1-fast": "retired by owner decision, 2026-10-23: Veo 3.1 Fast is no longer used",
  "google/veo-3.1-lite": "retired by owner decision, 2026-10-23: Veo 3.1 Lite is no longer used",
};
