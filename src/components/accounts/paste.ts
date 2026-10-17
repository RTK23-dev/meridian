/** One pasted link, @handle, or account ID, turned into the fields the account store requires. */
export type ParsedAccount = {
  externalAccountId: string;
  handle: string;
  name: string;
};

const LIMIT = 120;

function clip(value: string): string {
  return value.trim().slice(0, LIMIT);
}

/**
 * Accepts an Instagram, Facebook, YouTube, or TikTok link, an @handle, or a bare account ID.
 * A link with no profile path is rejected, so a bare domain is never stored as the account.
 * The display name starts as the handle or the ID. The form still lets the person change it.
 */
export function parseAccountPaste(raw: string): ParsedAccount | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const looksLikeUrl = trimmed.includes("://") || trimmed.includes("/") || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed);
  if (!looksLikeUrl) {
    const id = clip(trimmed.replace(/^@+/, ""));
    if (!id) return null;
    return { externalAccountId: id, handle: trimmed.startsWith("@") ? clip(`@${id}`) : "", name: clip(id) };
  }
  let path = "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    path = url.pathname;
  } catch {
    return null;
  }
  const parts = path.split("/").map((part) => part.trim()).filter((part) => part && part !== "channel" && part !== "c" && part !== "user");
  const id = clip((parts.at(-1) ?? "").replace(/^@+/, ""));
  if (!id) return null;
  const social = /instagram|tiktok|youtube/i.test(trimmed) || trimmed.includes("@");
  return { externalAccountId: id, handle: social ? clip(`@${id}`) : "", name: clip(id) };
}
