// The Settings screens, as the app has them: the six tabs of Settings (General, Members, Scoring weights, Alerts, Learning, Danger zone), and
// the pages the Settings page links to (billing, usage, integrations, setup, jobs, engine operations, audit, webhooks and notifications).
// Copy is taken from the app's own components. Sample names, numbers and dates are placeholders, and the notes say so.
import { head, tabs, grid, word, switchRow, slider, notice, fieldBox, offAction, plate } from "./screens.mjs";

const SETTINGS_TABS = ["General", "Members", "Scoring weights", "Alerts", "Learning", "Danger zone"];
const ALSO_IN_SETTINGS = ["Billing and limits", "Usage & cost", "Alerts center", "Audit log", "Webhook events", "Exports", "Notification preferences"];

/** The Settings page header and its six tabs. The workspace name is the title, as the app shows it. */
const settingsHead = (tab, lede = "You are owner. Permission checks run on the server, not only in this screen.") =>
  `${head(`Settings · ${tab}`, "Sample Studio", lede)}${tabs(SETTINGS_TABS, tab)}`;

/** One limit, with its value in a field, the Save and Clear actions, and what it blocks. A Save that would change nothing is off, with the reason beside it. */
const billingLimit = (id, label, value, status, blocks, changed = false) => `<div class="limit">
  ${fieldBox(id, label, value, `${blocks} ${status}`, "Not set")}
  <div class="limit-actions">${changed
    ? `<button type="button" class="btn btn-primary">Save</button>`
    : offAction("Save", `${id}-why`, "No change to save.")}
  ${value ? `<button type="button" class="btn btn-secondary">Clear</button>` : ""}</div>
</div>`;

export const SETTINGS_SCREENS = [
  // ---------------------------------------------------------------- General
  {
    id: "settings-general", group: "Settings", label: "General", title: "Settings, general", place: "settings",
    html: `${settingsHead("General")}
      <div class="also" role="group" aria-label="Other screens in Settings">${ALSO_IN_SETTINGS.map((l) => `<button type="button" class="btn btn-secondary">${l}</button>`).join("")}</div>
      ${plate("Workspace name", `<div class="inline-field">${fieldBox("ws-rename", "Name", "Sample Studio", "Only an admin can rename this workspace. Up to 80 characters.")}<button type="button" class="btn btn-secondary">Rename</button></div>`)}
      ${plate("Billing and limits", `<p class="row-note">The monthly budget, the brand budgets, the factory caps, the measure ceiling and the decision cap are set in one place. Nothing is set by default: a limit that is not set refuses the paid step it guards.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-quiet">Open billing and limits</button></div>`)}
      <ul class="rows" aria-label="Sections that open on demand">
        <li><div><p class="row-title">Create another workspace</p><p class="row-note">A second one keeps its own brands, members and keys</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li><div><p class="row-title">Keys and connections</p><p class="row-note">Every provider, its state and its key</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li><div><p class="row-title">Engine and provider settings</p><p class="row-note">Decision engine, models and connection tests</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li><div><p class="row-title">Text and image models</p><p class="row-note">Which model each task uses. Each choice is checked against the live catalogue before any paid call.</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li><div><p class="row-title">Google Drive</p><p class="row-note">Where files are kept</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li><div><p class="row-title">What is and is not connected</p><p class="row-note">For whoever runs the server</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
      </ul>`,
    notes: {
      does: "Holds the workspace name and six sections that open on demand: a second workspace, keys, engine settings, models, Drive, and what is and is not connected. The other Settings pages are one step away.",
      means: "Settings is the place for things that apply to the whole workspace. A section that is closed does not ask for attention until someone opens it.",
      checks: ["No red fill: nothing is committed on this tab", "Only an admin can rename, and the rule is written beside the field", "Each section says what it holds, in one line"],
    },
  },

  // ---------------------------------------------------------------- Members
  {
    id: "settings-members", group: "Settings", label: "Members", title: "Settings, members", place: "settings",
    html: `${settingsHead("Members", "Owners and admins manage people. Viewers can read the workspace. The server keeps at least one owner.")}
      <div class="scr-actions" style="justify-content:flex-end"><button type="button" class="btn btn-primary">Invite member</button></div>
      ${grid("Members", "minmax(0,1.5fr) minmax(0,1fr) 110px", ["Member", "Role", ""], [
        [`<span class="row-title">Ana Sample</span><span class="row-note">ana@example.com</span>`, `<span class="mono">owner</span>`, `<span class="row-note">Owner</span>`],
        [`<span class="row-title">Ben Sample</span><span class="row-note">ben@example.com</span>`, `<span class="mono">admin</span>`, `<button type="button" class="btn btn-quiet">Remove</button>`],
        [`<span class="row-title">Cy Sample</span><span class="row-note">cy@example.com</span>`, `<span class="mono">viewer</span>`, `<button type="button" class="btn btn-quiet">Remove</button>`],
      ])}
      ${plate("Pending invitations", `<ul class="rows"><li><div><p class="row-title">dana@example.com</p><p class="row-note">Invited as member</p></div><div class="row-action">${word("muted", "hollow", "Pending")}</div></li></ul>`)}
      <p class="row-note">Changing a role happens in its row. Removing a member asks first, in a dialog that names the person and says their past actions stay in the audit trail.</p>`,
    notes: {
      does: "Lists who can open the workspace, with a role each. An admin changes a role in the row, invites by email, and removes a member after one confirmation.",
      means: "Access is a list a person can read in one screen. Removing someone is never a single click, and the audit trail keeps what they did.",
      checks: ["One red action: Invite member", "The server keeps at least one owner, which the screen states", "Removal names the person and asks first"],
    },
  },

  // ---------------------------------------------------------------- Scoring weights
  {
    id: "settings-weights", group: "Settings", label: "Scoring weights", title: "Settings, scoring weights", place: "settings",
    html: `${settingsHead("Scoring weights", "These weights are not how Meridian finds an opportunity. They only scale a diagnostic score. Learning and evidence still decide the order.")}
      <div class="weights">
        <ul class="rows" aria-label="Diagnostic weights">
          <li><div class="wrow"><p class="row-title">Brand fit</p>${slider(3.0)}</div><p class="row-note">Adds to the score</p></li>
          <li><div class="wrow"><p class="row-title">Historical evidence</p>${slider(2.5)}</div><p class="row-note">Adds to the score</p></li>
          <li><div class="wrow"><p class="row-title">Market signal</p>${slider(2.0)}</div><p class="row-note">Adds to the score</p></li>
          <li><div class="wrow"><p class="row-title">Novelty</p>${slider(1.0)}</div><p class="row-note">Adds to the score</p></li>
          <li><div class="wrow"><p class="row-title">Reproducibility</p>${slider(1.5)}</div><p class="row-note">Adds to the score</p></li>
          <li><div class="wrow"><p class="row-title">Saturation (penalty)</p>${slider(1.0)}</div><p class="row-note">Penalty</p></li>
          <li><div class="wrow"><p class="row-title">Risk (penalty)</p>${slider(0.5)}</div><p class="row-note">Penalty</p></li>
        </ul>
        <aside class="plate-block" aria-label="Live preview">
          <p class="label">Live preview</p>
          <p class="row-note">Each factor's share of the total weight. Penalties are drawn dashed.</p>
          <ul class="share-list">
            <li><span>Brand fit</span><span class="mono">26%</span><span class="bar" style="width:26%"></span></li>
            <li><span>Historical evidence</span><span class="mono">22%</span><span class="bar" style="width:22%"></span></li>
            <li><span>Market signal</span><span class="mono">17%</span><span class="bar" style="width:17%"></span></li>
            <li><span>Novelty</span><span class="mono">9%</span><span class="bar" style="width:9%"></span></li>
            <li><span>Reproducibility</span><span class="mono">13%</span><span class="bar" style="width:13%"></span></li>
            <li><span>Saturation (penalty)</span><span class="mono">9%</span><span class="bar" data-penalty="true" style="width:9%"></span></li>
            <li><span>Risk (penalty)</span><span class="mono">4%</span><span class="bar" data-penalty="true" style="width:4%"></span></li>
          </ul>
        </aside>
      </div>
      <div class="scr-actions">${offAction("Save diagnostic weights", "save-weights-why", "Save is off until a weight changes.")}<button type="button" class="btn btn-secondary">Restore defaults</button></div>`,
    notes: {
      does: "Seven factors, each with a slider, a typed value and whether it adds to the score or takes away. A live preview shows each share of the total, with penalties drawn dashed.",
      means: "The weights only scale a diagnostic score. The screen says so before anyone touches a slider, so the score is not mistaken for the ranking.",
      checks: ["No red fill until a weight changes; then Save turns on", "Save is off with its reason beside it while nothing has changed", "Penalties are told apart by a dashed bar and a word, not by colour"],
    },
  },

  // ---------------------------------------------------------------- Learning
  {
    id: "settings-learning", group: "Settings", label: "Learning", title: "Settings, learning", place: "settings",
    html: `${settingsHead("Learning")}
      ${plate("Shared workspace patterns", `<p class="row-note">A brand always uses its own stored patterns. Patterns another brand in this workspace explicitly shared are used only by brands that turn this on. Global patterns are never used.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">What does this change?</button></div>`)}
      <ul class="rows">
        <li><div><p class="row-title">Harbour Coffee</p><p class="row-note">3 stored patterns for this brand and shared with it.</p>${switchRow("Use shared workspace patterns", true)}</div><div class="row-action"><button type="button" class="btn btn-quiet">Open learning</button></div></li>
        <li><div><p class="row-title">Northwind Tea</p><p class="row-note">0 stored patterns for this brand and shared with it.</p>${switchRow("Use shared workspace patterns", false, "Only a member or admin can change this")}</div><div class="row-action"><button type="button" class="btn btn-quiet">Open learning</button></div></li>
      </ul>`,
    notes: {
      does: "Turns on, per brand, whether it may read patterns that other brands in this workspace shared with it. A brand's own patterns are always used.",
      means: "Nothing is copied into a brand's brain by switching this on, and scoring does not change. Switching it off stops the brand reading shared patterns on its next decision.",
      checks: ["No red fill: the switch is the state, not an action", "Each brand's own count is shown before its switch", "The switch says in words whether it is on or off"],
    },
  },

  // ---------------------------------------------------------------- Danger zone
  {
    id: "settings-danger", group: "Settings", label: "Danger zone", title: "Settings, danger zone", place: "settings",
    html: `${settingsHead("Danger zone")}
      ${plate("Delete a brand", `<p class="row-note">Open the brand and use Delete brand in its danger zone. You type the brand name to confirm. The audit trail keeps a record.</p>
        <ul class="rows"><li><div><p class="row-title">Harbour Coffee</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open Harbour Coffee to delete it</button></div></li></ul>`)}
      ${plate("Delete this workspace", `<p class="row-note">This build does not delete a workspace, so no control is offered here. Brands can be deleted one at a time, as above.</p>`)}`,
    notes: {
      does: "Lists the brands and links each one to its own page, where the delete is. A workspace cannot be deleted from this build, and the page says so.",
      means: "There is one delete path for a brand, and it asks for the name. This tab does not add a second one.",
      checks: ["No red action on this tab: the delete happens on the brand's own page", "Each brand links to its own delete, and the link says where", "The workspace delete is said to be absent, not hidden"],
    },
  },

  // ---------------------------------------------------------------- Alerts (the tab)
  {
    id: "settings-alerts", group: "Settings", label: "Alerts tab", title: "Settings, alerts", place: "settings",
    html: `${settingsHead("Alerts")}
      ${plate("Alert delivery", `<p class="row-note">Alerts, acknowledgement and the webhook target are managed in the Alerts center.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Open the Alerts center</button></div>`)}`,
    notes: {
      does: "Points to the Alerts center, where alerts are read and the webhook target is set. The tab does not repeat them.",
      means: "There is one place for alerts. A person who changes delivery goes to the same screen as the one that shows the alerts.",
      checks: ["No red fill: the one action opens the Alerts center", "A member sees that only an admin can change delivery, instead of the link", "The tab does not duplicate the alert list"],
    },
  },

  // ---------------------------------------------------------------- Billing and limits
  {
    id: "billing", group: "Settings", label: "Billing and limits", title: "Billing and limits", place: "settings",
    html: `${head("Settings · Billing and limits", "Billing and limits", "Every money and spend limit in Meridian, in one place. Nothing is set by default: a limit that is not set refuses the paid step it guards, and says so. Each change is recorded with its value before and after.")}
      ${plate("Workspace", `<p class="row-note">These limits apply to the whole workspace, across every brand. The monthly budget is a limit Meridian enforces, not your OpenRouter account balance. It applies to each calendar month (UTC) across paid text and video.</p>
        ${billingLimit("monthly-budget", "Monthly budget (USD)", "500", "Saved value is 250. This new value is not saved yet.", "Blocks any paid step once the month's committed spend reaches it.", true)}
        ${billingLimit("measure-ceiling", "Measure ceiling (USD per second)", "", "Not set.", "Refuses the measure step until a value is saved.")}
        ${billingLimit("decision-cap", "Decision cap (USD)", "", "Not set.", "Refuses the decision step until a value is saved.")}`)}
      ${plate("Brands", `<p class="row-note">Each brand has its own budget and its own factory caps. The factory does not spend a brand's money until both its daily and its total cap are set.</p>
        <p class="label" style="margin-top:6px">Harbour Coffee</p>
        ${billingLimit("brand-budget", "Brand budget (USD)", "200.00", "Committed so far: $42.10.", "Blocks paid steps for this brand once it is spent.")}
        ${billingLimit("factory-daily", "Factory daily cap (USD)", "", "Not set.", "Refuses factory runs for this brand until a value is saved.")}
        ${billingLimit("factory-total", "Factory total cap (USD)", "", "Not set.", "Refuses factory runs for this brand until a value is saved.")}`)}
      ${plate("Estimates", `<p class="row-note">These are not limits. The engine uses them to estimate a master's cost before it starts. They are read-only here.</p><p class="row-title">The fixed cost of one master is about $0.80 before its shots.</p>`)}`,
    notes: {
      does: "Lists every limit for the workspace and each brand, with its value or the words Not set, what it blocks, and a Save that is on only when the value has changed.",
      means: "A limit that is not set refuses the paid step it guards, and the screen says so next to the field. The monthly budget is Meridian's own limit, not an account balance.",
      checks: ["One red action: the one Save with a changed value", "Every Save that would change nothing is off, with its reason beside it", "Estimates are shown as read-only, so they are never mistaken for limits"],
    },
  },

  // ---------------------------------------------------------------- Usage and cost
  {
    id: "usage", group: "Settings", label: "Usage & cost", title: "Usage and cost", place: "settings",
    html: `${head("Settings · Usage &amp; cost", "Usage &amp; cost", "Model runs recorded for this workspace. A cost a run did not report stays unknown. It is never counted as zero.")}
      <dl class="figures">
        <div><dt class="label">Recorded runs</dt><dd>1,248</dd><dd class="cap">Recorded in this workspace.</dd></div>
        <div><dt class="label">Tokens</dt><dd>2.4 M</dd><dd class="cap">14 runs have no token count.</dd></div>
        <div><dt class="label">Cost</dt><dd>$38.17</dd><dd class="cap">14 runs have no cost. They are not counted as zero.</dd></div>
      </dl>
      <section class="stack"><h2 class="row-title">By operation</h2>${grid("By operation", "minmax(0,1.2fr) 90px minmax(0,1.4fr) 110px", ["Operation", "Runs", "Tokens", "Cost"], [
        ["Plan", "412", `1.1 M <span class="bar-inline" style="width:78%"></span>`, "$12.40"],
        ["Script", "301", `0.8 M <span class="bar-inline" style="width:56%"></span>`, "$9.10"],
        ["Image", "350", `<span class="is-missing">not recorded</span>`, `$11.20 <span class="row-note">14 without a cost</span>`],
        ["Speech", "185", `0.5 M <span class="bar-inline" style="width:34%"></span>`, "$5.47"],
      ])}</section>
      <section class="stack"><h2 class="row-title">By day (UTC)</h2>${grid("By day", "minmax(0,1.2fr) 90px minmax(0,1.4fr) 110px", ["Day (UTC)", "Runs", "Tokens", "Cost"], [
        ["Oct 28", "96", `0.4 M <span class="bar-inline" style="width:70%"></span>`, "$6.02"],
        ["Oct 27", "81", `0.3 M <span class="bar-inline" style="width:52%"></span>`, "$5.30"],
        ["Oct 26", "74", `0.3 M <span class="bar-inline" style="width:48%"></span>`, "$4.81"],
      ])}</section>`,
    notes: {
      does: "Shows the recorded runs, tokens and cost for the workspace, then the same figures by operation and by day. A bar is drawn only where the count is real.",
      means: "A cost that a run did not report is shown as unknown, with how many runs it covers. The total is never presented as complete when it is not.",
      checks: ["No red fill: usage is read, not acted on", "Missing tokens and costs say not recorded, never zero", "Only an admin sees these figures, as the next screen shows"],
    },
  },

  // ---------------------------------------------------------------- Integrations
  {
    id: "integrations", group: "Settings", label: "Integrations", title: "Integrations, workspace logins", place: "settings",
    html: `${head("Settings · Integrations", "Workspace logins", "Sign in once for this workspace. Paid ads and performance use this login. A brand still names its own page or ad account on Connected accounts. A login is connected only after a request to it succeeds.")}
      <section class="stack"><div><h2 class="row-title">Ads</h2><p class="row-note">Accounts that report or publish ads.</p></div>
        <ul class="rows">
          <li><div>${word("success", "filled", "Connected")}</div><div><p class="row-title">Meta</p><p class="row-note">Posts and ads can be published. Last checked two hours ago.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Test connection</button><button type="button" class="btn btn-quiet">Disconnect</button></div></li>
          <li><div>${word("danger", "cross", "Error")}</div><div><p class="row-title">TikTok</p><p class="row-note">The token was refused on 30 October. Reconnect to publish again.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Reconnect</button></div></li>
          <li><div>${word("warning", "plug", "NOT CONNECTED")}</div><div><p class="row-title">Google Ads</p><p class="row-note">Connect to publish ads. Nothing is published until you connect.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Connect</button></div></li>
        </ul>
        <p class="notice" data-tone="muted"><span class="row-title">Publishing: </span>Meta can publish. TikTok needs a new login. Google Ads is not connected, so no ad is published to it.</p>
      </section>
      <section class="stack"><div><h2 class="row-title">Research</h2><p class="row-note">Sources and indexes that read evidence.</p></div>
        <ul class="rows">
          <li><div>${word("success", "filled", "Configured")}</div><div><p class="row-title">Google AI Studio</p><p class="row-note">Workspace key ending 4f2a. An admin can remove it.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Test connection</button><button type="button" class="btn btn-quiet">Remove workspace key</button></div></li>
          <li><div>${word("muted", "dashed", "Set by the server")}</div><div><p class="row-title">Embeddings</p><p class="row-note">A deployment setting. This screen does not change it.</p></div><div class="row-action"></div></li>
        </ul>
      </section>
      <section class="stack"><div><h2 class="row-title">Infrastructure</h2><p class="row-note">Storage, delivery, and background processes.</p></div>
        <ul class="grid-3">
          <li class="plate-block"><div class="row-action" style="justify-content:space-between">${word("success", "filled", "RUNNING")}<span class="row-title">Worker</span></div><p class="row-note">Background jobs are picked up. The last heartbeat was 6 seconds ago.</p></li>
          <li class="plate-block"><div class="row-action" style="justify-content:space-between">${word("success", "filled", "RUNNING")}<span class="row-title">Scheduler</span></div><p class="row-note">Timed runs are queued. The last heartbeat was 9 seconds ago.</p></li>
        </ul>
      </section>`,
    notes: {
      does: "Lists each login with its true state in words, the reason in one sentence, and its actions. Background processes are shown beside the providers, with their own heartbeat.",
      means: "A login shows as connected only after a request to it succeeded. Publishing says which logins are missing, so nothing looks ready that is not.",
      checks: ["No red fill: every action is secondary", "Each state has a word, a dot and a reason", "The publishing line names what is missing, not only that something is"],
    },
  },

  // ---------------------------------------------------------------- Setup guide
  {
    id: "setup-guide", group: "Settings", label: "Setup guide", title: "Setup guide", place: "settings",
    html: `${head("Settings · Setup guide", "Setup guide", "Each step says what it is, why it matters, and what the saved records show now. The steps run in order, and the current step is the first one not done. Keys are saved on the step that needs them, through the same admin-only path as Settings. Nothing here is checked against a live provider.")}
      <ol class="rows steps-list" aria-label="Setup steps">
        <li><div>${word("success", "filled", "Done")}</div><div><p class="row-title">Create your first brand</p><p class="row-note">Everything else belongs to a brand, so nothing can be made until one exists.</p></div><div class="row-action"></div></li>
        <li><div>${word("accent", "hollow", "Do this now")}</div><div><p class="row-title">Choose a decision engine</p><p class="row-note">No idea is graded until an engine is chosen and ready.</p></div><div class="row-action"><button type="button" class="btn btn-primary">Choose an engine</button></div></li>
        <li><div>${word("muted", "dashed", "Optional")}</div><div><p class="row-title">Connect a video maker</p><p class="row-note">Only needed when Meridian should produce media itself.</p></div><div class="row-action"></div></li>
        <li><div>${word("muted", "hollow", "To do")}</div><div><p class="row-title">Connect Google Drive</p><p class="row-note">Without Drive, a reference video cannot be uploaded to a draft.</p></div><div class="row-action"></div></li>
        <li><div>${word("warning", "hollow", "Could not check")}</div><div><p class="row-title">Where examples come from</p><p class="row-note">Better examples give better patterns. With no source at all, there is nothing to compare against. The sources could not be read just now.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Check again</button></div></li>
        <li><div>${word("muted", "dashed", "Optional")}</div><div><p class="row-title">Publish your work</p><p class="row-note">Only needed to publish. Until then, the export holds everything Meridian made.</p></div><div class="row-action"></div></li>
      </ol>`,
    notes: {
      does: "Lists each setup step in order, with its state in words, why it matters, and the one action for the step that is current. A step that could not be checked says so, and is not shown as to do.",
      means: "A person knows what to do next, and why each step is there. Nothing is marked done or to do without a record to show it.",
      checks: ["One red action: the step that is current", "A step that could not be checked is not called to do", "Optional steps say they are optional"],
    },
  },

  // ---------------------------------------------------------------- Jobs and health
  {
    id: "jobs", group: "Settings", label: "Jobs & health", title: "Jobs and health", place: "settings",
    html: `${head("Settings · Jobs &amp; health", "Jobs &amp; health", "Worker and scheduler heartbeats, the queue, and the job records for this workspace. Payload values are never shown here.")}
      <dl class="figures">
        <div><dt class="label">Worker</dt>${word("success", "filled", "RUNNING")}<dd class="cap">Last heartbeat 6 seconds ago.</dd></div>
        <div><dt class="label">Queue depth</dt><dd>3</dd><dd class="cap">Waiting to run.</dd></div>
        <div><dt class="label">Dead letter</dt><dd>0</dd><dd class="cap">Nothing has stopped for good.</dd></div>
      </dl>
      ${grid("Jobs", "minmax(0,1.3fr) minmax(0,1fr) 108px 84px 96px 110px", ["Type", "Brand", "Status", "Attempts", "Created", "Actions"], [
        ["Still 1 render", "Harbour Coffee", word("success", "filled", "Done"), "1 of 3", "09:14:02", `<button type="button" class="btn btn-quiet">Details</button>`],
        ["Speech", "Harbour Coffee", word("danger", "cross", "Failed"), "3 of 3", "08:12:45", `<button type="button" class="btn btn-quiet">Details</button> <button type="button" class="btn btn-secondary">Retry</button>`],
        ["Script", "Northwind Tea", word("accent", "filled", "Running"), "1 of 3", "09:21:37", `<button type="button" class="btn btn-quiet">Details</button>`],
      ])}
      <p class="row-note">Page 1 of 5. You are on the first page. Retry queues the job again; it does not repeat a paid step that already finished.</p>`,
    notes: {
      does: "Shows the worker and scheduler, the queue, the jobs that stopped for good, and each job with its state, attempts and actions. Retry and cancel are offered only where they apply.",
      means: "When a job fails, the person sees the attempts, the time and the next action without opening a log. The screen never shows the payload.",
      checks: ["No red fill: Retry is secondary, and cancel is not offered for a finished job", "A missing duration says not recorded, never zero", "Payload values are not shown"],
    },
  },

  // ---------------------------------------------------------------- Engine operations
  {
    id: "engine-ops", group: "Settings", label: "Engine operations", title: "Engine operations", place: "settings",
    html: `${head("Settings · Engine operations", "Engine operations", "How the video engine has run in this workspace: request counts, the time each stage takes, how often each provider succeeds, and the engine's jobs that stopped for good. Meridian's own background jobs are on Jobs & health. Replaying an engine job can spend money, so only admins can do it.")}
      <section class="stack"><h2 class="row-title">Last seven days</h2>
        <dl class="figures figures-5">
          <div><dt class="label">Requests</dt><dd>214</dd></div>
          <div><dt class="label">Delivered</dt><dd>188</dd></div>
          <div><dt class="label">Running</dt><dd>6</dd></div>
          <div><dt class="label">Paused</dt><dd>4</dd></div>
          <div><dt class="label">Rejected</dt><dd>16</dd></div>
        </dl>
      </section>
      <section class="stack"><h2 class="row-title">Time per stage</h2>${grid("Time per stage", "minmax(0,1.2fr) 110px 70px 130px 130px", ["Stage", "Basis", "Runs", "Typical (p50)", "Slow end (p95)"], [
        ["Plan", "measured", "62", "4.1 s", "11.8 s"],
        ["Image", "measured", "140", "9.6 s", "not enough data"],
        ["Speech", "measured", "9", "not enough data", "not enough data"],
      ])}</section>
      <section class="stack"><h2 class="row-title">Alerts</h2>
        <ul class="rows">
          <li><div>${word("danger", "cross", "Needs attention now")}</div><div><p class="row-title">Provider circuit open</p><p class="row-note">The image provider opened its circuit at 08:40. Requests wait until it closes.</p></div><div class="row-action"></div></li>
          <li><div>${word("warning", "hollow", "Look today")}</div><div><p class="row-title">Gate pass rate dropped</p><p class="row-note">Fewer drafts passed the review gate than in the week before.</p></div><div class="row-action"></div></li>
        </ul>
      </section>
      <section class="stack"><h2 class="row-title">Stopped jobs</h2>
        <div class="inline-field">${fieldBox("request-id", "Request id", "", "Dead jobs are read only for the request typed here.", "req_")}</div>
        ${offAction("Replay job", "replay-why", "Type a request id to list its stopped jobs. Replaying an engine job can spend money, so only admins can do it.")}
      </section>
      <p class="row-note">Concurrency proposals are shown only. Nothing on this page changes the size of a bucket.</p>`,
    notes: {
      does: "Shows seven days of engine requests, the time each stage takes, the alerts the engine proposes, and the stopped jobs for one request. Replay is off until a request is named.",
      means: "A slow stage or an open provider circuit is visible without a log. Replay spends money, so it is off until a request is named, and only an admin can use it.",
      checks: ["No red fill: replay is off until a request is named, and it can spend money", "A stage with no data says not enough data, never zero", "The page says that the concurrency proposals change nothing"],
    },
  },

  // ---------------------------------------------------------------- Audit log
  {
    id: "audit", group: "Settings", label: "Audit log", title: "Audit log", place: "settings",
    html: `${head("Settings · Audit log", "Audit log", "Administrative history for this workspace, newest first. Entries are limited to this workspace.")}
      <form class="fields-grid" aria-label="Filter the audit log">
        ${fieldBox("audit-actor", "Actor name or ID", "", "", "")}
        ${fieldBox("audit-action", "Action", "", "Part of the action code, such as calibration or job.", "calibration.approved")}
        <div class="field-box"><label class="field-label" for="audit-brand">Brand</label><span id="audit-brand" class="field mono">All brands and the workspace</span></div>
        ${fieldBox("audit-from", "From date", "", "", "")}
        ${fieldBox("audit-to", "To date", "", "", "")}
        <div class="off-row"><button type="button" class="btn btn-primary">Apply filters</button>${offAction("Clear", "audit-clear-why", "No filters are set.", "btn-quiet")}</div>
      </form>
      ${plate("Export CSV", `<p class="row-note">Exports are generated when you click. The file uses the filters above, holds at most 5,000 of the newest matching entries, and downloads to this device.</p><div class="scr-actions" style="margin-top:10px"><button type="button" class="btn btn-secondary">Export matching entries</button></div>`)}
      <p class="row-note" aria-live="polite">Showing 1–50 of 812 entries</p>
      ${grid("Audit entries", "minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.2fr) 110px minmax(0,1.2fr)", ["When", "Actor", "Action", "Brand", "Object"], [
        ["Oct 28, 16:40", "Ana Sample", `<span class="mono">calibration.approved</span>`, "Harbour Coffee", `calibration_proposal · <span class="mono">p_3f1a</span>`],
        ["Oct 28, 11:02", "Ben Sample", `<span class="mono">billing.limit.saved</span>`, "Workspace", `monthly_budget · <span class="mono">ws_01</span>`],
        ["Oct 27, 09:15", "Ana Sample", `<span class="mono">member.role.changed</span>`, "Workspace", `member · <span class="mono">u_22</span>`],
      ])}
      <div class="pager"><button type="button" class="btn btn-secondary" disabled aria-describedby="audit-page-why">Previous page</button><p class="row-note" id="audit-page-status">Page 1 of 17. You are on the first page.</p><button type="button" class="btn btn-secondary">Next page</button><p class="row-reason" id="audit-page-why">The first page has no previous page.</p></div>`,
    notes: {
      does: "Lists administrative actions for the workspace, newest first, with filters for who, what, which brand and which dates. The filtered rows can be exported.",
      means: "Every change to limits, roles, calibration and billing is on one list with its value, so a change can be traced without a log file.",
      checks: ["One red action: Apply filters", "Clear says why it is off while no filter is set", "The export is generated on click and never cached"],
    },
  },

  // ---------------------------------------------------------------- Webhook events
  {
    id: "webhooks", group: "Settings", label: "Webhook events", title: "Webhook events", place: "settings",
    html: `${head("Settings · Webhook events", "Webhook events", "Each row is a webhook that arrived, with its provider event ID and the time it was received. The index does not record whether an event was processed, and it does not store payloads.")}
      <div class="inline-field">${fieldBox("webhook-provider", "Provider", "", "The provider key as stored, such as meta or tiktok. Leave empty for all providers.", "meta")}<button type="button" class="btn btn-secondary">Apply filter</button></div>
      <p class="row-note" aria-live="polite">Showing 1–50 of 3,402 events</p>
      ${grid("Webhook events", "minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr)", ["Received", "Provider", "Provider event ID"], [
        ["Oct 28, 16:12", "Meta", `<span class="mono">evt_1Qx9a2</span>`],
        ["Oct 28, 15:48", "Meta", `<span class="mono">evt_1Qx99k</span>`],
        ["Oct 28, 14:30", "TikTok", `<span class="mono">Not given</span>`],
      ])}
      <div class="pager"><button type="button" class="btn btn-secondary" disabled aria-describedby="events-why">Previous page</button><p class="row-note">Page 1 of 69. You are on the first page.</p><button type="button" class="btn btn-secondary">Next page</button><p class="row-reason" id="events-why">The first page has no previous page.</p></div>`,
    notes: {
      does: "Lists the webhooks that arrived, by provider, with the provider's event ID and when each arrived. It does not show payloads, and it does not say whether an event was processed.",
      means: "A person can confirm a provider sent something, and when. Whether it was processed is a question for Jobs & health, not this list.",
      checks: ["No red fill: the filter is applied with a secondary action", "The page says what the index does not record", "No payload is stored or shown"],
    },
  },

  // ---------------------------------------------------------------- Notification preferences
  {
    id: "notifications", group: "Settings", label: "Notification preferences", title: "Notification preferences", place: "settings",
    html: `${head("Settings · Notification preferences", "Notification preferences", "Choose which in-app notifications appear for you in this workspace. These preferences do not control external webhook delivery.")}
      <ul class="rows">
        <li>${switchRow("Learning updates", true, "Shown in your in-app workspace feed")}</li>
        <li>${switchRow("Performance recorded", true, "Shown in your in-app workspace feed")}</li>
        <li>${switchRow("Review required", true, "Shown in your in-app workspace feed")}</li>
        <li>${switchRow("Integration unavailable", false, "Hidden from your in-app workspace feed")}</li>
      </ul>
      ${notice("muted", "A preference applies to you only. Webhook targets are set in Alerts, and do not change when a switch here is turned off.")}`,
    notes: {
      does: "Turns each kind of in-app notification on or off for the person. Each switch says in words whether it is on, and what it does.",
      means: "A person chooses what reaches their feed. Changing a preference here does not change what the workspace sends to an outside webhook.",
      checks: ["No red fill: each switch is a state, not an action", "Every switch names its effect in words", "The note says what the switches do not control"],
    },
  },
];
