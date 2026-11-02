// The workspace screens that are not inside Settings: the workspace overview (Home), the alerts center (Home, because alerts need a person),
// exports (Library), and starting a new brand (Create). Copy follows the app's components. Sample names and numbers are placeholders.
import { head, word, fieldBox, offAction, plate } from "./screens.mjs";

export const WORKSPACE_SCREENS = [
  // ---------------------------------------------------------------- Workspace overview
  {
    id: "overview", group: "Home", label: "Workspace overview", title: "Workspace overview", place: "home",
    html: `${head("Home", "Workspace overview", "A current view of Sample Studio, its brands, and work that needs attention.", `<button type="button" class="btn btn-secondary">New brand</button>`)}
      <dl class="figures">
        <div><dt class="label">Brands</dt><dd>3</dd></div>
        <div><dt class="label">Open reviews</dt><dd>7</dd><dd class="cap">Across the brands that have loaded.</dd></div>
        <div><dt class="label">Failed jobs</dt><dd>1</dd><dd class="cap">Jobs that stopped with an error.</dd></div>
      </dl>
      ${plate("Needs attention", `<ul class="rows">
        <li><div>${word("danger", "cross", "Review waiting")}</div><div><p class="row-title">Harbour Coffee has 3 reviews waiting</p><p class="row-note">A person decides each one before it can be approved.</p></div><div class="row-action"><button type="button" class="btn btn-primary">Open review</button></div></li>
        <li><div>${word("danger", "cross", "Connection refused")}</div><div><p class="row-title">TikTok's token was refused</p><p class="row-note">Publishing to TikTok stops until it is reconnected.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Reconnect</button></div></li>
        <li><div>${word("muted", "hollow", "Thin brand")}</div><div><p class="row-title">Northwind Tea's brain is 40% complete</p><p class="row-note">The required fields come first. Plans are not drawn until they are filled.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Open brand</button></div></li>
      </ul>`)}
      ${plate("Team", `<p class="row-note">Shows what the team is doing from the workspace's job counts. The art director also waits on open reviews, which stay unknown until every brand has loaded.</p>`)}
      ${plate("Setup", `<p class="row-title">Next: choose a decision engine</p><p class="row-note">Two steps are done. Nothing is graded until an engine is chosen.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-quiet">Open the setup guide</button></div>`)}
      <ul class="grid-3" aria-label="Brands">
        <li class="plate-block"><p class="row-title">Harbour Coffee</p><p class="row-note">Brain complete: 9 of 10 required fields.</p><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li class="plate-block"><p class="row-title">Northwind Tea</p><p class="row-note">Brain not complete: 4 of 10 required fields.</p><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        <li class="plate-block"><p class="row-title">Sample Brand C</p><p class="row-note">No products yet. Start with the brand brain.</p><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
      </ul>
      ${plate("Recent activity", `<ul class="rows">
        <li><div><p class="row-title">Ana Sample changed the calibration baseline</p><p class="row-note">Harbour Coffee · Oct 28, 16:40</p></div></li>
        <li><div><p class="row-title">Ben Sample changed the monthly budget</p><p class="row-note">Workspace · Oct 28, 11:02</p></div></li>
      </ul>`)}`,
    notes: {
      does: "Shows the workspace's counts, what needs attention across the brands, the team's state, the next setup step, each brand, and recent activity. Every item is a link to the place that can fix it.",
      means: "The overview is for deciding where to go next. A count that has not loaded is unknown, never zero, and the screen says so.",
      checks: ["One red action: Open review, the first item", "Each attention item names the brand and the next step", "Activity names the person, the place and the time"],
    },
  },

  // ---------------------------------------------------------------- Alerts center
  {
    id: "alerts", group: "Home", label: "Alerts center", title: "Alerts center", place: "home",
    html: `${head("Home", "Alerts center", "Alerts Meridian raised for this workspace. Acknowledging one records that a person has seen it. It changes no threshold and no provider setting.", `<button type="button" class="btn btn-primary">Check systems</button>`)}
      <section class="stack">
        <div class="inline-field"><div><p class="row-title">Alerts</p><p class="row-note">2 open, 5 stored.</p></div><div class="field-box"><label class="field-label" for="alert-show">Show</label><span id="alert-show" class="field">Open</span></div></div>
        <ul class="rows">
          <li><div>${word("danger", "cross", "Critical")}<p class="row-note">Open</p></div><div><p class="row-title">budget_overrun</p><p class="row-note">Monthly spend is over the budget for Harbour Coffee. The first seen time is Oct 28, 09:40. Delivery: not sent, because no target is set.</p><div class="scr-actions" style="margin-top:10px"><button type="button" class="btn btn-secondary" aria-label="Acknowledge budget_overrun alert">Acknowledge</button></div></div></li>
          <li><div>${word("warning", "hollow", "Warning")}<p class="row-note">Acknowledged</p></div><div><p class="row-title">dead_letter_growth</p><p class="row-note">Stopped jobs grew over the day. Acknowledged by Ana Sample on Oct 27.</p></div></li>
        </ul>
      </section>
      ${plate("Delivery target", `<div class="inline-field">${word("muted", "plug", "NOT CONNECTED")}</div>
        <p class="row-note">Alerts are not sent anywhere until a target is saved.</p>
        <div class="inline-field">${fieldBox("alert-url", "Webhook URL", "", "Must start with https. Plain http is allowed only for localhost. The URL is not shown again after you save it.", "https://example.com/alerts")}</div>
        ${offAction("Save target", "target-why", "Type the webhook URL to save it as the delivery target.")}`)}`,
    notes: {
      does: "Lists the alerts the workspace raised, with an acknowledge action for each open one, and sets the one webhook that alerts are sent to. It can check the systems on demand.",
      means: "Acknowledging records that a person has seen an alert, and nothing else. A target that is not saved means alerts are not sent anywhere, and the screen says so.",
      checks: ["One red action: Check systems", "Save target is off until a URL is typed, with its reason beside it", "The saved URL is not shown again, and the screen says so"],
    },
  },

  // ---------------------------------------------------------------- Exports
  {
    id: "exports", group: "Library", label: "Exports", title: "Exports", place: "library",
    html: `${head("Library", "Exports", "Exports are generated when you click. Each file is built from the records in this workspace and downloads to this device.")}
      <div class="field-box"><label class="field-label" for="export-brand">Brand for opportunities and library</label><span id="export-brand" class="field">Harbour Coffee</span><p class="row-reason">Each brand is exported on its own.</p></div>
      <div class="grid-2">
        ${plate("Opportunities", `<p class="row-note">One row per opportunity for the selected brand, with its rank score, JEV decision, probability, evidence confidence, risk and reason. An empty cell means the value is not stored.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-primary">Export opportunities</button></div>`)}
        ${plate("Library", `<p class="row-note">The newest 50 creative records for the selected brand: ID, title, hook, angle, status, origin and creation time. Media files are not included.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Export library</button></div>`)}
        ${plate("Audit log", `<p class="row-note">The newest audit entries for this workspace, up to the export cap of 5,000 rows. Filter the audit log first to export a narrower set.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Export audit log</button><button type="button" class="btn btn-quiet">Filter the audit log first</button></div>`)}
        ${plate("Performance rows", `<p class="row-note">One row per stored performance observation for the selected brand. A spend, impression, reach, click, conversion or revenue value that was never recorded is an empty cell, not 0.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Export performance rows</button></div>`)}
        ${plate("Export package", `<p class="row-note">This brand has no creatives to package yet.</p>${offAction("Export package", "package-why", "There is nothing to package until a creative is made for this brand.")}`)}
      </div>`,
    notes: {
      does: "Exports the opportunities, the library, the audit log, the performance rows, and a package for the brand, one file at a time. Each export is built on click and downloads to the device.",
      means: "Nothing is exported in the background, and a missing value is an empty cell rather than a zero. A package with nothing in it is off, with the reason written.",
      checks: ["One red action: Export opportunities", "The audit export is shown only to admins; a member is told who to ask", "A brand with no creatives says so, and its package is off"],
    },
  },

  // ---------------------------------------------------------------- New brand
  {
    id: "new-brand", group: "Create", label: "New brand", title: "New brand", place: "create",
    html: `${head("Create · New brand", "Start with what you know", "Two things are needed: the brand name and what you sell. Everything else can wait for the brand brain. A website is kept as a reference. Nothing is scraped from it here.")}
      <form class="form-col" aria-label="New brand">
        ${fieldBox("brand-name", "Brand name", "", "Required.", "Harbour Coffee")}
        ${fieldBox("brand-site", "Website", "", "Optional. Stored as a reference only.", "https://example.com")}
        <div class="field-box"><label class="field-label" for="brand-sells">What do you sell?</label><textarea id="brand-sells" class="field brief-area" rows="3" aria-describedby="brand-sells-hint">Roasted coffee beans and cold brew kits</textarea><p class="row-reason" id="brand-sells-hint">Required. Up to 500 characters.</p></div>
        <div class="plate-block"><p class="row-title">Add more detail <span class="row-note">(optional: industry, market, customers, notes)</span></p><p class="row-note">Closed until wanted. Anything typed here still saves.</p></div>
        <div class="scr-actions" style="margin-top:8px"><button type="button" class="btn btn-primary">Create brand</button></div>
      </form>`,
    notes: {
      does: "Asks for the brand name and what it sells, and folds the optional detail until someone wants it. A website is stored as a reference only.",
      means: "A brand can start with two facts. Everything else is filled in later, in the brand brain, where it belongs.",
      checks: ["One red action: Create brand", "Only the name and what is sold are required, and each says so", "A website is stored, not scraped, and the field says so"],
    },
  },
];
