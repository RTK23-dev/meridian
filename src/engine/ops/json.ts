// Reads a stored JSON text as a plain object. Stored bodies are untrusted data: a value that does not parse is null, and the caller
// treats the field as unknown (fail closed), never as a default.

/** The object a stored JSON text holds, or null when it is not valid JSON or is not an object. */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
