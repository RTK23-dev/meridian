/** Where OAuth may send the person after the workspace login is stored. Anything else goes to Integrations. */
const BRAND_ACCOUNTS = /^\/brands\/[A-Za-z0-9_-]+\/accounts$/;

export function oauthReturnPath(raw: string | null | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "/integrations" || BRAND_ACCOUNTS.test(value)) return value;
  return "/integrations";
}
