// The direction id lists a page needs (the Scripts panel's niche and job choices, and the server functions' input checks). Plain data
// with no imports, so a client bundle can read them without the codex's engine imports. codex.ts re-exports them: they are the codex's.

export const NICHE_FAMILIES = [
  "education",
  "entertainment",
  "ecommerce",
  "beauty",
  "fitness",
  "finance",
  "food",
  "tech",
  "b2b",
  "home",
  "parenting",
  "travel",
  "local",
] as const;

export const VIDEO_JOBS = ["reach", "follow", "convert"] as const;
