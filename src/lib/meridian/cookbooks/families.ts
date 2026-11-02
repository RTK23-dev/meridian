// The families a cookbook can belong to (round 3, K19). A leaf module with no imports, so the library screen can read the list in the browser
// without the cookbook schema (which needs the engine contracts). schema.ts re-exports it.

export const COOKBOOK_FAMILIES = ["explainer", "ugc", "product", "listicle", "story", "other"] as const;
