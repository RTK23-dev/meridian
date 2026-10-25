/**
 * Ends a page call that has no timeout of its own. A page evaluate and an accessibility scan wait for the page's script to answer, so
 * a page that never answers holds the run until the watchdog ends it, with only the route named. This rejects with the call's name
 * and the seconds it waited, so the log names the call as well as the route. The call itself is not cancelled; the run ends with the
 * failure.
 */
export function withDeadline(label, ms, promise) {
  const wait = ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${wait}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
