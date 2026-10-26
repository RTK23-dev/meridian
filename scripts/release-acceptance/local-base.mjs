const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Validate before any request or browser action: release acceptance must never target a remote service. */
export function localAcceptanceBase(value = "http://127.0.0.1:8080") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release acceptance requires an HTTP loopback URL with no path, query, or fragment.");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Release acceptance requires an HTTP loopback URL with no credentials, path, query, or fragment.");
  }
  return url.origin;
}
