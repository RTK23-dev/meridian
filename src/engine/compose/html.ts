// Escaping for every string that reaches compiled HTML (Bible 9.1, L8). Ad text, script text and product copy are
// untrusted: they enter the composition only as escaped text or as escaped JSON inside an attribute, never as markup.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * JSON for a `data-variable-values` attribute. The JSON is escaped as attribute text, so no value can close the
 * attribute or start a tag. JSON.stringify is deterministic for the plain objects the compiler builds.
 */
export function attributeJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}
