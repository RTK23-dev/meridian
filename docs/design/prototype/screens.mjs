// The full web design, screen by screen: the markup, the copy and the notes for each screen of the proposal. Every number and every
// name here is sample data, and the screens say so. A screen with a plan mounts the plan component (mount.mjs) where data-mount="plan".
// presentation.mjs draws these screens; the capture checks each one.

import { esc } from "./mount.mjs";

/** The globe mark, drawn from the logo spec. Its red meridian is the place you are. */
export const globe = (px, spin = true) => `<svg class="globe" style="width:${px}px;height:${px}px" viewBox="0 0 320 320" aria-hidden="true" focusable="false"><circle class="globe-outline" cx="160" cy="160" r="150"></circle><ellipse class="globe-line" cx="160" cy="160" rx="150" ry="26"></ellipse><ellipse class="globe-line" cx="160" cy="160" rx="118" ry="134"></ellipse><ellipse class="globe-line globe-faint" cx="160" cy="160" rx="72" ry="150"></ellipse><ellipse class="globe-line globe-faint" cx="160" cy="88" rx="134" ry="18"></ellipse><ellipse class="globe-line globe-faint" cx="160" cy="232" rx="134" ry="18"></ellipse><g class="globe-meridian" style="${spin ? "" : "animation:none"}"><ellipse class="globe-red" cx="160" cy="160" rx="22" ry="150"></ellipse></g></svg>`;

/** The five places, as the rail shows them. The current place is marked, and the rail holds the brand. */
const PLACES = [["home", "Home", "⌂"], ["create", "Create", "+"], ["library", "Library", "▤"], ["insights", "Insights", "∿"], ["settings", "Settings", "⚙"]];
export const railMarkup = (place) => `<nav class="app-rail" aria-label="Places">
  <p class="app-brand">${globe(22, false)}Meridian</p>
  ${PLACES.map(([id, label, icon]) => `<span class="rail-mock-item${id === place ? " is-current" : ""}"${id === place ? ' aria-current="page"' : ""}><span class="mono" aria-hidden="true">${icon}</span>${label}</span>`).join("")}
</nav>`;

/** A progress bar: done steps have a filled number, the current one is red, the rest are muted. */
export const steps = (items) => `<div class="steps" role="list" aria-label="Progress">${items.map(([label, state], i) => `<div class="step" role="listitem" data-state="${state}"${state === "current" ? ' aria-current="step"' : ""}><span class="n" aria-hidden="true">${state === "done" ? "✓" : i + 1}</span>${label}</div>`).join("")}</div>`;

export const tabs = (items, current) => `<div class="pres-tabs">${items.map((t) => `<span${t === current ? ' aria-current="true"' : ""}>${t}</span>`).join("")}</div>`;

export const head = (kicker, title, lede = "", actions = "") => `<div class="scr-head"><div><p class="label">${kicker}</p><h1 class="scr-title">${title}</h1>${lede ? `<p class="scr-lede">${lede}</p>` : ""}</div>${actions ? `<div class="scr-actions">${actions}</div>` : ""}</div>`;

const CHIPS = [
  "A 30-second product video built from our brand photos",
  "Rebuild a viral reference as an on-brand version",
  "A presenter explains one offer in 20 seconds",
  "Three short ads for one product, each with a different hook",
];

const PLAN_STEPS = (current) => steps([["Brief", current === "brief" ? "current" : "done"], ["Plan", current === "plan" ? "current" : current === "review" ? "done" : "todo"], ["Review", current === "review" ? "current" : "todo"]]);

// ---- The chart: sample weekly shares, drawn to a scale that the labels name. ----
const chartPoints = (values) => values.map((v, i) => `${60 + i * 90},${280 - v * 4}`).join(" ");
const SHORT = [34, 38, 31, 42, 40, 44, 39, 46];
const LONG = [22, 24, 21, 26, 25, 27, 24, 28];
const chartMarkup = `<svg class="chart" viewBox="0 0 720 300" role="img" aria-label="Line chart of the sample share of posts that held attention past five seconds, by week. Short hooks are above long intros in most weeks.">
  ${[0, 15, 30, 45, 60].map((v) => `<line class="grid" x1="60" x2="690" y1="${280 - v * 4}" y2="${280 - v * 4}"></line><text class="axis" x="12" y="${284 - v * 4}">${v}%</text>`).join("")}
  ${SHORT.map((_, i) => `<text class="axis" x="${60 + i * 90}" y="298" text-anchor="middle">W${i + 1}</text>`).join("")}
  <polyline class="series-a" points="${chartPoints(LONG)}"></polyline>
  <polyline class="series-b" points="${chartPoints(SHORT)}"></polyline>
</svg>`;

// ---- The library: sample outputs, with the state each one is in. ----
const TILES = [
  ["Spring offer, 30 s", "Ready", "success", "Sep 3"],
  ["Product in use, 9:16", "In review", "warning", "Oct 28"],
  ["Voice-over, English", "Blocked", "danger", "Oct 27"],
  ["Presenter intro", "Draft", "muted", "Oct 21"],
  ["Old hook test", "Ready", "success", "Sep 14"],
  ["Reference remake", "Blocked", "danger", "Oct 9"],
];

const libraryTiles = TILES.map(([title, word, tone, date], i) => `<button type="button" class="tile"${i === 1 ? ' aria-current="true"' : ""}>
  <span class="tile-art" aria-hidden="true">No preview</span>
  <span class="tile-title">${esc(title)}</span>
  <span class="state-word" data-tone="${tone}">${word}</span>
  <span class="cap">${date}</span>
</button>`).join("");

const SHARED_SHELL_NOTE = "Each screen is the proposed design at the width shown. Sample names, numbers and dates are placeholders.";

// ---- Shared pieces for every screen module. Each draws with the same classes and the same states, so a new screen reads like the others. ----

/** A table drawn the way the app draws its lists: headers, then rows of cells. `widths` sets the columns as CSS track sizes. */
export const grid = (label, widths, headers, rows) => `<div class="dtable" role="table" aria-label="${esc(label)}" style="--cols:${widths}">
  <div class="row head" role="row">${headers.map((h) => `<span role="columnheader">${h}</span>`).join("")}</div>
  ${rows.map((cells) => `<div class="row" role="row">${cells.map((c) => `<span role="cell">${c}</span>`).join("")}</div>`).join("")}
</div>`;

/** A state word with its dot. The tone colours it, and the word says it, so colour is never the only signal. */
export const word = (tone, dot, text) => `<span class="state-word" data-tone="${tone}"><span class="dot dot-${dot}" aria-hidden="true"></span>${text}</span>`;

/** A switch, drawn as a specimen. Its state is in words beside the knob. */
export const switchRow = (name, on, hint = "") => `<div class="switch-row"><span class="switch" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${esc(name)}"><span class="knob" aria-hidden="true"></span></span><span><span class="row-title">${esc(name)}</span><span class="row-note">${on ? "On" : "Off"}${hint ? `. ${hint}` : ""}</span></span></div>`;

/** A slider at a value on a scale of 0 to `max`, with the typed value beside it. */
export const slider = (value, max = 5) => `<span class="slide-row"><span class="slide" aria-hidden="true"><span class="fill" style="width:${(value / max) * 100}%"></span><span class="thumb" style="left:${(value / max) * 100}%"></span></span><span class="mono">${value.toFixed(1)}</span></span>`;

/** A notice: what is true now, in a sentence, with a tone. */
export const notice = (tone, text) => `<p class="notice" data-tone="${tone}">${text}</p>`;

/** A labelled field, drawn. A value is shown as typed; an empty field shows its placeholder, and the hint says what the field does. */
export const fieldBox = (id, label, value, hint = "", placeholder = "") => `<div class="field-box"><label class="field-label" for="${id}">${label}</label><input id="${id}" class="field" type="text" ${value ? `value="${esc(value)}"` : `placeholder="${esc(placeholder)}"`} aria-describedby="${id}-hint"><p class="row-reason" id="${id}-hint">${hint}</p></div>`;

/** A button that is off, with the reason in words beside it. The reason is linked to the button, so a screen reader reads both. */
export const offAction = (label, id, why, variant = "btn-secondary") => `<div class="off-action"><button type="button" class="btn ${variant}" disabled aria-describedby="${id}">${label}</button><p class="row-reason" id="${id}">${why}</p></div>`;

/** A bordered block with a label and its body, for a group of related things on one screen. */
export const plate = (label, body) => `<section class="plate-block"><p class="label">${label}</p>${body}</section>`;

export const BASE_SCREENS = [
  // ---------------------------------------------------------------- Sign in
  {
    id: "login", group: "Start", label: "Sign in", title: "Sign in", shell: "bare",
    html: `<div class="login">
      ${globe(128)}
      <p class="wordmark">Meridian</p>
      <p class="scr-lede" style="margin:0">Make and measure videos and ads from one brief.</p>
      <form class="login-form" novalidate>
        <label class="field-label" for="login-email">Email</label>
        <input id="login-email" class="field" type="email" placeholder="you@company.com" aria-describedby="login-help">
        <p class="row-reason" id="login-help">Use the address your workspace invited you with.</p>
        <button type="button" class="btn btn-primary">Sign in</button>
      </form>
    </div>`,
    notes: {
      does: "Asks for one address and offers one action. The mark turns once, and then rests.",
      means: "Someone who opens Meridian for the first time knows where to start, and nothing else competes for attention.",
      checks: ["One red action", "The help line names the one thing the person needs", "No password is implied, because none is stored by this screen"],
    },
  },

  // ---------------------------------------------------------------- First run
  {
    id: "setup", group: "Start", label: "First run", title: "First run, step 2", shell: "bare",
    html: `<div class="app-main" style="width:100%;max-width:700px;margin:0 auto">
      ${steps([["Sign in", "done"], ["Name your workspace", "current"], ["Add a brand", "todo"]])}
      ${head("First run · Step 2 of 3", "Name your workspace", "One name. You can change it later in Settings.")}
      <form class="setup-form" novalidate>
        <label class="field-label" for="ws-name">Workspace name</label>
        <input id="ws-name" class="field" type="text" placeholder="For example: Sample Studio" aria-describedby="ws-help">
        <p class="row-reason" id="ws-help">This name appears on your plans and your exports.</p>
        <div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-primary">Continue</button><button type="button" class="btn btn-quiet">Back</button></div>
      </form>
    </div>`,
    notes: {
      does: "Asks for one thing per step. Three steps, each with a word and a number, and a bar that shows where the person is.",
      means: "Nothing else is asked yet, so the first step takes a few seconds. Going back keeps what was typed.",
      checks: ["One red action", "The progress bar names every step and marks the current one", "Back is a quiet action, so it never competes with Continue"],
    },
  },

  // ---------------------------------------------------------------- Home
  {
    id: "home", group: "Home", label: "Today", title: "Today", place: "home",
    html: `${head("Home", "Today", "What needs you, and what is running.", `<button type="button" class="btn btn-primary">Create</button>`)}
      <div>
        <p class="label" style="margin-bottom:8px">Needs you · 3</p>
        <ul class="rows">
          <li><div><p class="state-word" data-tone="warning"><span class="dot dot-pause" aria-hidden="true"></span>Paused at budget</p></div><div><p class="row-title">Voice-over</p><p class="row-note">The copy budget for this run is used up. Raise it to continue.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Open plan</button></div></li>
          <li><div><p class="state-word" data-tone="warning"><span class="dot dot-plug" aria-hidden="true"></span>NOT CONNECTED</p></div><div><p class="row-title">Shot: three cuts of the product</p><p class="row-note">No video provider is connected. Connect one in Settings to run this step.</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Connect</button></div></li>
          <li><div><p class="state-word" data-tone="success"><span class="dot dot-filled" aria-hidden="true"></span>Ready to review</p></div><div><p class="row-title">Still 2</p><p class="row-note">The result is drawn and its checks have run. It needs a review before it can be approved.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Review</button></div></li>
        </ul>
      </div>
      <div>
        <p class="label" style="margin-bottom:8px">Running now</p>
        <div class="run">${globe(24)}<div><p class="row-title">Planning the video</p><p class="row-note">Still 1 is working. 2 of 8 steps are done.</p></div></div>
      </div>
      <div>
        <p class="label" style="margin-bottom:12px">Sample figures, not from a real account</p>
        <dl class="figures">
          <div><dt class="label">Runs this month</dt><dd>4</dd></div>
          <div><dt class="label">Recorded cost</dt><dd>$1.07</dd><dd class="cap">Charged by providers so far.</dd></div>
          <div><dt class="label">Estimated, not yet paid</dt><dd>$0.42</dd><dd class="cap">Planned for steps that have not run.</dd></div>
        </dl>
      </div>`,
    notes: {
      does: "Lists what needs the person, one action for each item, then what is running, then three figures. Each figure says whether it was recorded or estimated.",
      means: "The first screen answers one question: what do I do now? A running item is shown as working, not as finished.",
      checks: ["One red action, in the header", "Each item has a state word, a reason and one action", "The estimate says it is not paid; the recorded cost says it was charged"],
    },
  },

  // ---------------------------------------------------------------- Home, empty
  {
    id: "home-empty", group: "Home", label: "Empty Today", title: "Today, with nothing to do", place: "home",
    html: `${head("Home", "Today")}
      <div style="display:grid;justify-items:center;gap:16px;padding:56px 0;text-align:center">
        ${globe(104)}
        <h2 class="empty-title">Nothing needs you.</h2>
        <p class="scr-lede" style="margin:0">Start with a brief. Runs and their results appear here.</p>
        <div class="scr-actions"><button type="button" class="btn btn-primary">Create</button></div>
      </div>`,
    notes: {
      does: "Shows an empty Today with one sentence and one action. The mark turns once when the screen opens, then rests.",
      means: "Empty does not mean broken. The screen says why it is empty and what to do next.",
      checks: ["One red action, in the body", "No empty table or grey placeholder boxes", "The mark rests, so nothing moves while the person reads"],
    },
  },

  // ---------------------------------------------------------------- Brief
  {
    id: "brief", group: "Create", label: "Brief", title: "Brief", place: "create",
    html: `${head("Create · Brief", "Plan a run", "Describe the video. The plan is drawn when you plan it.", `<button type="button" class="btn btn-secondary">Ask the assistant</button>`)}
      ${steps([["Brief", "current"], ["Plan", "todo"], ["Review", "todo"]])}
      <div class="form-col">
        <label class="field-label" for="brief-goal">What should the video do?</label>
        <textarea id="brief-goal" class="field brief-area" rows="4">${esc(CHIPS[0])}</textarea>
        <p class="label" style="margin-top:22px">Start from an example</p>
        <ul class="chips" style="margin-top:10px">${CHIPS.map((c) => `<li><button type="button" class="chip">${esc(c)}</button></li>`).join("")}</ul>
        <dl class="facts">
          <div><dt>Brand</dt><dd>Stored for this workspace</dd></div>
          <div><dt>Format</dt><dd class="mono">9:16, 30 seconds</dd></div>
          <div><dt>Budget</dt><dd class="mono">$0.50</dd></div>
          <div><dt>Model</dt><dd>Stored for this workspace. Change it in Settings.</dd></div>
        </dl>
        <div class="row-nc"><p class="row-title">Reference files</p><p class="row-reason"><span class="state-inline" data-tone="warning"><span class="dot dot-plug" aria-hidden="true"></span>NOT CONNECTED</span> Connect file storage in Settings to attach files.</p></div>
        <div class="scr-actions" style="margin-top:22px"><button type="button" class="btn btn-primary">Plan it</button></div>
      </div>`,
    notes: {
      does: "Asks for one goal, offers examples, and lists the facts the plan needs. The facts are read-only here, with a link to change them.",
      means: "The brief is one object and it is kept as you write it. Anything that cannot be attached yet is a row that says why.",
      checks: ["One red action: Plan it", "NOT CONNECTED names the missing thing and the next step", "Examples fill the field and nothing else"],
    },
  },

  // ---------------------------------------------------------------- Plan
  {
    id: "plan", group: "Create", label: "Plan", title: "Plan", place: "create",
    html: `${head("Create · Plan", "A 30-second product video", "Steps appear as the plan is drawn. Select one to see its details.")}
      ${PLAN_STEPS("plan")}
      <div class="plan-host" data-mount="plan"></div>`,
    notes: {
      does: "Draws the plan as steps in columns. Select a step to open its details on the right. The plan stays where it is.",
      means: "The selected step is the same step in every view. A disabled action names the steps that need the person first.",
      checks: ["No red fill: Resume is off, and the reason is written beside it", "The selection is one red edge, and it moves with the step", "Tab walks the steps in reading order"],
    },
  },

  // ---------------------------------------------------------------- Plan, when it fails
  {
    id: "plan-error", group: "Create", label: "Plan, when it fails", title: "Plan that could not be drawn", place: "create",
    html: `${head("Create · Plan", "A 30-second product video", "Steps appear as the plan is drawn. Select one to see its details.")}
      ${PLAN_STEPS("plan")}
      <div class="err">
        <p class="label">Plan not drawn</p>
        <h3>The plan could not be drawn</h3>
        <p>The model returned a plan that did not pass its checks. Nothing was started, and your brief is kept.</p>
        <div class="scr-actions" style="margin-top:6px"><button type="button" class="btn btn-secondary">Try again</button><button type="button" class="btn btn-quiet">Edit the brief</button></div>
        <p class="cap">Request id 7f3c-2a9e</p>
      </div>`,
    notes: {
      does: "Says that the plan failed, why in one sentence, and that nothing was started. The brief is kept, and the request id is printed so support can find the run.",
      means: "A failure is named, not hidden. The person can try again or edit the brief, and nothing has been paid for.",
      checks: ["No red fill: Try again is secondary", "The error keeps the danger edge and says nothing was started", "The request id is shown in full, in mono"],
    },
  },

  // ---------------------------------------------------------------- Review
  {
    id: "review", group: "Create", label: "Review", title: "Review", place: "create",
    html: `${head("Create · Review", "Review before you approve", "Four checks run before anything can be approved. A blocked check stops approval until it is cleared.")}
      ${PLAN_STEPS("review")}
      <div class="review-grid">
        <div style="display:grid;gap:14px;justify-items:start">
          <div class="preview"><p>Preview not rendered. Nothing was made yet.</p></div>
          <p class="cap">Sample: no media was made for this draft.</p>
        </div>
        <div style="display:grid;gap:26px;min-width:0">
          <dl class="figures" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div><dt class="label">Recorded so far</dt><dd>$1.07</dd></div>
            <div><dt class="label">Estimated for the rest</dt><dd>$0.42</dd></div>
          </dl>
          <p class="cap">Recorded is what providers charged. Estimated is planned, and not yet paid.</p>
          <ul class="gates">
            <li><span class="row-title">Originality</span><span class="state-word" data-tone="success"><span class="dot dot-filled" aria-hidden="true"></span>Pass</span><span class="gate-note">No match to the source material.</span></li>
            <li><span class="row-title">Claims</span><span class="state-word" data-tone="warning"><span class="dot dot-hollow" aria-hidden="true"></span>Review</span><span class="gate-note">A price is named without a source. Add the source or remove the price.</span></li>
            <li><span class="row-title">Policy</span><span class="state-word" data-tone="success"><span class="dot dot-filled" aria-hidden="true"></span>Pass</span><span class="gate-note">Nothing in the plan breaks the policy in use.</span></li>
            <li><span class="row-title">Rights</span><span class="state-word" data-tone="danger"><span class="dot dot-cross" aria-hidden="true"></span>Blocked</span><span class="gate-note">A reference clip has no licence on file. Replace it to continue.</span></li>
          </ul>
          <div class="scr-actions"><button type="button" class="btn btn-primary" disabled aria-describedby="approve-why">Approve</button><button type="button" class="btn btn-quiet">Back to plan</button></div>
          <p class="row-reason" id="approve-why">Approve is off until Rights is cleared. Only approvers can approve.</p>
        </div>
      </div>`,
    notes: {
      does: "Shows the draft, its cost, and four checks. Each check says pass, review or blocked, with the reason in words.",
      means: "Approval is the last step, and it is off while a check is blocked. The cost says which part was charged and which is only planned.",
      checks: ["No red fill: Approve is disabled, and its reason is beside it", "Every check has a word, a dot and a reason", "The preview says nothing was made, instead of showing a placeholder that looks finished"],
    },
  },

  // ---------------------------------------------------------------- Library
  {
    id: "library", group: "Library", label: "Library", title: "Library", place: "library",
    html: `${head("Library", "Library", "Everything made or kept, in one place.")}
      <div class="toolbar-row">
        <input class="field" type="search" placeholder="Search by title" aria-label="Search the library">
        <div class="seg" role="group" aria-label="Filters">
          <button type="button" aria-pressed="true">Type: all</button>
          <button type="button" aria-pressed="false">Status: all</button>
          <button type="button" aria-pressed="false">Date: last 30 days</button>
        </div>
      </div>
      <div class="lib-grid">
        <div class="tiles">${libraryTiles}</div>
        <aside class="details" aria-label="Details of the selected item">
          <p class="state-word" data-tone="warning"><span class="dot dot-hollow" aria-hidden="true"></span>In review</p>
          <p class="row-title" style="font-size:20px;line-height:26px">Product in use, 9:16</p>
          <p class="row-note" style="margin:0">Claims need a source before approval.</p>
          <dl>
            <div><dt>Made from</dt><dd>Plan 1, 8 steps</dd></div>
            <div><dt>Recorded cost</dt><dd class="mono">$0.88</dd></div>
            <div><dt>Last changed</dt><dd class="mono">Oct 28, 16:40</dd></div>
          </dl>
          <div class="scr-actions"><button type="button" class="btn btn-primary">Open in review</button></div>
        </aside>
      </div>`,
    notes: {
      does: "A grid of what was made, with three filters at most. Selecting a tile opens its details beside the grid, with one action.",
      means: "Each item is named by its state. A tile without media says there is no preview, rather than showing a picture that is not there.",
      checks: ["One red action, in the details", "Three filters, each with a reset path", "Cost says recorded, and the title says what is missing"],
    },
  },

  // ---------------------------------------------------------------- Insights
  {
    id: "insights", group: "Insights", label: "Insights", title: "Insights, market", place: "insights",
    html: `${head("Insights", "Insights", "What the market and your results say, and where each number comes from.")}
      ${tabs(["Market", "Results", "Learning"], "Market")}
      <div class="chart-wrap">
        <p class="row-title">Posts that held attention past five seconds, by week</p>
        ${chartMarkup}
        <div class="legend">
          <span><span class="swatch-line" style="border-color:var(--accent)"></span>Short hooks</span>
          <span><span class="swatch-line" style="border-color:var(--fg-muted)"></span>Long intros</span>
        </div>
        <p class="cap">Source: sample dataset. Not recorded from your account.</p>
      </div>
      <div class="means-note">
        <p class="label">What this means</p>
        <p>Short hooks held attention longer in this sample. Eight weeks is a small sample, so treat the gap as a lead to test, not a result.</p>
      </div>`,
    notes: {
      does: "Shows one lead chart with its source printed beneath it, and a plain sentence on what it means.",
      means: "A chart is only useful with its source and its size. The sentence says how much weight the number can bear.",
      checks: ["No red fill: the red series is the one focus", "Source and sample size are printed", "Each tab keeps its own filters and place"],
    },
  },

  // ---------------------------------------------------------------- Connect an account
  {
    id: "connect", group: "Settings", label: "Connect an account", title: "Connect Google Ads", place: "settings",
    html: `${head("Settings · Connections", "Connect Google Ads", "Three steps. This one sends you to Google and back. It publishes nothing.")}
      ${steps([["Choose", "done"], ["Authorise", "current"], ["Confirm", "todo"]])}
      <div class="means-note" style="max-width:640px">
        <p>You will be sent to Google to approve access, then returned here. Nothing is published by this step.</p>
        <p class="row-reason">You can disconnect at any time from Settings.</p>
      </div>
      <div class="scr-actions"><button type="button" class="btn btn-primary">Continue to Google</button><button type="button" class="btn btn-quiet">Cancel</button></div>`,
    notes: {
      does: "Connecting an account is a short sequence with the same progress bar as the Create flow. The middle step says what happens outside Meridian.",
      means: "The person knows they are leaving, and that this step publishes nothing.",
      checks: ["One red action: Continue to Google", "The progress bar uses the same states as the Create flow", "Cancel is quiet, so it does not look like a second choice"],
    },
  },

  // ---------------------------------------------------------------- Command palette
  {
    id: "palette", group: "Overlay", label: "Command palette", title: "Command palette, over Today", place: "home",
    html: `${head("Home", "Today", "What needs you, and what is running.", `<button type="button" class="btn btn-primary">Create</button>`)}
      <ul class="rows" style="opacity:0.4"><li><div><p class="row-title">Voice-over</p></div></li><li><div><p class="row-title">Shot: three cuts of the product</p></div></li></ul>`,
    overlay: `<div class="pal-scrim" aria-hidden="true"></div>
      <div class="pal" role="dialog" aria-label="Command palette">
        <input class="pal-input" type="search" placeholder="Type a screen, step or action" aria-label="Search screens, steps and actions">
        <div class="pal-group">
          <p class="label">Go to</p>
          <div class="pal-row" aria-selected="true"><span>Create</span><span class="cap">Enter</span></div>
          <div class="pal-row" aria-selected="false"><span>Today</span><span class="cap">G then H</span></div>
          <div class="pal-row" aria-selected="false"><span>Library</span><span class="cap">G then L</span></div>
          <div class="pal-row" aria-selected="false"><span>Settings</span><span class="cap">G then S</span></div>
        </div>
        <div class="pal-group">
          <p class="label">Actions</p>
          <div class="pal-row" aria-selected="false"><span>New brief</span><span class="cap">N</span></div>
          <div class="pal-row" aria-selected="false"><span>Open the last plan</span><span class="cap">O</span></div>
        </div>
      </div>`,
    notes: {
      does: "Opens over any screen with one keystroke. It groups results by where they go, and each row shows its key.",
      means: "Any screen, step or action is reachable by name. The selected row has the red edge, and Escape closes it.",
      checks: ["No red fill: the selected row has an edge, not a fill", "Every row shows its key", "Escape returns focus to the screen"],
    },
  },
];

/** The cover: what the walkthrough is, and what is checked on every screen. */
export const COVER = {
  id: "cover", group: "Start", label: "Cover", title: "Cover",
  html: `<div class="cover">
    <p class="label">Meridian · Web design · Redesign</p>
    <h1 class="cover-title">Meridian, redesigned, screen by screen.</h1>
    <p class="cover-lede">Forty-eight screens and states: the five places of the app, the brand workspace, the Settings pages, the public pages, and the command palette. One system throughout: the plan at any distance, words before colour, red for the one thing happening now, and nothing shown that is not real.</p>
    <div class="cover-grid">
      <article class="note-plate">
        <p class="label">How to read a screen</p>
        <p>Each screen is drawn at the width shown. Beside it, the notes say what it does, what it means, and what was checked on that screen.</p>
        <p class="cap">Use Previous and Next, or the arrow keys. Phone switches the frame to phone width.</p>
      </article>
      <article class="note-plate">
        <p class="label">Checked on every screen</p>
        <ul>
          <li>One red action at most, measured on every frame.</li>
          <li>Every disabled control says why, in words beside it.</li>
          <li>Numbers say what they are: recorded, estimated, or not recorded.</li>
          <li>Sample data is labelled. No screen shows a success that did not happen.</li>
          <li>Colour off: every state still reads, from its word and its dot.</li>
        </ul>
      </article>
    </div>
    <p class="cap">${SHARED_SHELL_NOTE}</p>
  </div>`,
  notes: null,
};

/** The notes for a screen, drawn beneath its frame. */
export const notesMarkup = (notes) => {
  if (!notes) return "";
  return `<article class="note-plate"><p class="label">Does</p><p>${esc(notes.does)}</p><p class="label" style="margin-top:6px">Means</p><p>${esc(notes.means)}</p></article>
    <article class="note-plate"><p class="label">Checked here</p><ul>${notes.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></article>`;
};
