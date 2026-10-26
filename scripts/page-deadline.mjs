/**
 * Ends a page call that has no timeout of its own. A page evaluate and an accessibility scan wait for the page's script to answer, so
 * a page that never answers holds the run until the watchdog ends it, with only the route named. This rejects with the call's name
 * and the seconds it waited, so the log names the call as well as the route. The call itself is not cancelled; the run ends with the
 * failure. An onExpire callback, if given, adds its text to the message, for example what the page was doing (page-diagnostics.mjs).
 */
async function detailOf(onExpire) {
  if (!onExpire) return "";
  try {
    return await onExpire();
  } catch (error) {
    return `The diagnostic failed: ${error.message}`;
  }
}

export function withDeadline(label, ms, promise, { onExpire } = {}) {
  const wait = ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      detailOf(onExpire).then((detail) => reject(new Error(`${label} did not finish within ${wait}${detail ? `. ${detail}` : ""}`)));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
