/**
 * What a page was doing when a call stopped answering. The UI baseline records the page's crashes, dialogs, navigations, requests
 * still in flight and console errors as they happen, so a deadline that fires can say what the page was doing, and a screenshot of
 * the stalled page is kept with the run. The recorder only listens. The one thing it changes is that it dismisses a dialog, which
 * Playwright does by itself when nothing listens for one.
 */

const KEEP = 20;
const TEXT_LIMIT = 200;
const SHOWN = 5;

function trim(text, limit = TEXT_LIMIT) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function keep(list, item) {
  list.push(item);
  if (list.length > KEEP) list.shift();
}

export function recordPage(page, now = () => Date.now()) {
  const state = { crashes: 0, dialogs: [], messages: [], navigations: [], inFlight: new Map() };
  page.on("crash", () => {
    state.crashes += 1;
  });
  page.on("dialog", (dialog) => {
    keep(state.dialogs, trim(`${dialog.type()}: ${dialog.message()}`));
    dialog.dismiss().catch(() => undefined);
  });
  page.on("pageerror", (error) => keep(state.messages, { at: now(), text: trim(`uncaught: ${error.message}`) }));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      keep(state.messages, { at: now(), text: trim(`${message.type()}: ${message.text()}`) });
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) keep(state.navigations, { at: now(), url: trim(frame.url(), 160) });
  });
  page.on("request", (request) => state.inFlight.set(request, { at: now(), url: trim(request.url(), 160) }));
  const finished = (request) => state.inFlight.delete(request);
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  return state;
}

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

export function describeStall(state, now = Date.now()) {
  const parts = [state.crashes ? `renderer crashed ${state.crashes} time(s)` : "no renderer crash"];
  if (state.dialogs.length) parts.push(`dialogs: ${state.dialogs.join("; ")}`);
  const navigation = state.navigations.at(-1);
  if (navigation) parts.push(`last navigation to ${navigation.url}, ${seconds(now - navigation.at)} before`);
  const pending = [...state.inFlight.values()].sort((a, b) => a.at - b.at);
  parts.push(
    pending.length
      ? `${pending.length} request(s) in flight, the oldest ${pending[0].url} for ${seconds(now - pending[0].at)}`
      : "no request in flight",
  );
  const messages = state.messages.slice(-SHOWN);
  parts.push(
    messages.length
      ? `last page messages: ${messages.map((item) => `${item.text} (${seconds(now - item.at)} before)`).join(" | ")}`
      : "no page errors or warnings",
  );
  return parts.join("; ");
}

// A screenshot of a page whose script does not answer may itself wait, so it has its own limit, and its failure is reported, not thrown.
export async function captureStall(page, path, timeout = 15_000) {
  try {
    await page.screenshot({ path, timeout });
    return `Screenshot of the stalled page: ${path}.`;
  } catch (error) {
    return `No screenshot of the stalled page: ${trim(error.message.split("\n")[0], 160)}.`;
  }
}
