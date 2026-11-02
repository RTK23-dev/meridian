// The brand screens: a brand's overview, its content hub (Create), cookbooks, the orchestrator plan, the brand brain, products, the pages it
// publishes from, and its research and results (Market, Intelligence, Calibration). Copy follows the app's own routes and components.
// The sample brand is Harbour Coffee; every number and name is a placeholder.
import { head, steps, tabs, grid, word, switchRow, fieldBox, offAction, plate } from "./screens.mjs";

const CONTENT_SECTIONS = ["Ideas", "Create", "Review", "Library", "Publish", "Results", "Batch"];

export const BRAND_SCREENS = [
  // ---------------------------------------------------------------- Brand overview
  {
    id: "brand-overview", group: "Home", label: "Brand overview", title: "Brand overview", place: "home",
    html: `${head("Home · Harbour Coffee", "Harbour Coffee", "Complete brand brain · 9 of 10 required fields · 34 of 40 fields · Version 3", `<button type="button" class="btn btn-secondary">Open brand brain</button>`)}
      ${steps([["Brain", "done"], ["Products", "done"], ["Market", "current"], ["Intelligence", "todo"], ["Content", "todo"], ["Calibration", "todo"]])}
      <div class="grid-2">
        ${plate("Next action", `<p class="row-title">Research the market for this brand</p><p class="row-note">Start with one public page URL. Meridian reads it and stores the text as evidence you can review.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-primary">Open market</button></div>`)}
        ${plate("Missing", `<ul class="rows">
          <li><div><p class="row-title">Two required brain fields are empty</p><p class="row-note">They read Empty. Not inferred, so nothing fills them for you.</p></div></li>
          <li><div><p class="row-title">No competitor observation is stored</p><p class="row-note">Ranking reads only stored observations.</p></div></li>
        </ul>`)}
      </div>
      ${plate("Where things live", `<ul class="rows">
        <li><div><p class="row-title">Cookbooks</p><p class="row-note">The cookbooks a video can be made from: their steps, their cost and what each needs, and copies you can make and edit.</p></div></li>
        <li><div><p class="row-title">Market</p><p class="row-note">Find public pages and posts, collect ads, and store competitor observations.</p></div></li>
        <li><div><p class="row-title">Content</p><p class="row-note">Ideas ranks what to make next. Create makes images and videos, Review holds them for a person, Library keeps them, Publish sends them out, Results shows what worked, and Batch (admins only) starts research-led production runs.</p></div></li>
      </ul>`)}
      ${plate("Brand details", `<p class="row-note">Name, website and what the brand sells. Changing them needs a member role.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Edit details</button></div>`)}
      ${plate("Delete brand", `<p class="row-note">Only an admin sees this. Type Harbour Coffee to confirm. The audit trail keeps a record.</p>${offAction("Delete brand", "delete-brand-why", "Type the brand name first.", "btn-quiet")}`)}`,
    notes: {
      does: "Shows how complete the brand brain is, where the brand is in the loop, the next action with its one button, what is missing, where each kind of work lives, and the brand's details. Admins see the one delete, which asks for the name.",
      means: "The next step is named from stored data, not guessed, and a second link would contradict it. The brand can be deleted only from here, by typing its name.",
      checks: ["One red action: Open market, the next step", "The loop shows the step that is current, and the steps before it are done", "Delete is off until the name is typed, and the reason is beside it"],
    },
  },

  // ---------------------------------------------------------------- Content hub
  {
    id: "content", group: "Create", label: "Content", title: "Content", place: "create",
    html: `${head("Create · Content", "Harbour Coffee", "Ideas ranks what to make next. Create makes images and videos, Review holds them for a person, Library keeps them, Publish sends them out, Results shows what worked, and Batch (admins only) starts research-led production runs.")}
      ${tabs(CONTENT_SECTIONS, "Ideas")}
      ${plate("Ideas, ranked", `<ul class="rows">
        <li><div><p class="row-title">1 · Short hook, product in use</p><p class="row-note">Held attention past five seconds in 3 of 4 stored posts. Ranked first because the brand has no post like it yet.</p></div><div class="row-action"><button type="button" class="btn btn-primary">Make this</button></div></li>
        <li><div><p class="row-title">2 · Long intro, founder story</p><p class="row-note">Held attention in 1 of 4 stored posts. Ranked lower on the same evidence.</p></div><div class="row-action"><button type="button" class="btn btn-secondary">Make this</button></div></li>
        <li><div><p class="row-title">3 · Price comparison</p><p class="row-note">Not ranked: a price is named without a source, and it goes to review before it can be made.</p></div><div class="row-action">${offAction("Make this", "idea3-why", "Add the source for the price before this idea can be made.")}</div></li>
      </ul>`)}`,
    notes: {
      does: "Holds the whole loop for one brand as sections: Ideas, Create, Review, Library, Publish, Results and Batch. The first section opens by default, ranked by the stored evidence.",
      means: "What to make next is a ranking with its reason beside it. An idea with a claim that has no source is off until the source is added.",
      checks: ["One red action: Make this, on the top-ranked idea", "Each idea names its evidence in one sentence", "An idea that cannot be made says why, beside its action"],
    },
  },

  // ---------------------------------------------------------------- Cookbooks
  {
    id: "cookbooks", group: "Create", label: "Cookbooks", title: "Cookbooks", place: "create",
    html: `${head("Create · Cookbooks", "Cookbooks", "The cookbooks a video can be made from: their steps, their cost and what each needs, and copies you can make and edit.")}
      <div class="seg" role="group" aria-label="Filter the cookbooks"><button type="button" aria-pressed="true">All</button><button type="button" aria-pressed="false">Made in this workspace</button></div>
      <div class="lib-grid">
        <ul class="rows">
          <li><div><p class="row-title">Product in use, 9:16</p><p class="row-note">Made in this workspace. 6 steps, 2 with no model call.</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
          <li><div><p class="row-title">Speaker to camera</p><p class="row-note">A presenter explains one offer. 5 steps.</p></div><div class="row-action"><button type="button" class="btn btn-quiet">Open</button></div></li>
        </ul>
        <aside class="plate-block" aria-label="Selected cookbook">
          <p class="row-title">Product in use, 9:16</p>
          <p class="row-note">In Create, the run's Cookbook step offers it, with the settings below as its defaults.</p>
          <p class="label" style="margin-top:8px">Settings</p>
          <p class="row-note">This cookbook has no settings.</p>
          <p class="label" style="margin-top:8px">Save as my cookbook</p>
          <p class="row-note">A copy is yours to edit. It keeps a link to this cookbook.</p>
          <div class="scr-actions" style="margin-top:10px"><button type="button" class="btn btn-primary">Save as my cookbook</button></div>
        </aside>
      </div>`,
    notes: {
      does: "Lists the cookbooks a video can be made from, with each one's steps and what they need. The selected one shows its settings, and a copy can be saved as the person's own.",
      means: "A cookbook is a recipe the person can read before running it. A copy is theirs to change, and it keeps the link to the original.",
      checks: ["One red action: Save as my cookbook", "A cookbook with no settings says so", "Filters show as pressed, one at a time"],
    },
  },

  // ---------------------------------------------------------------- Orchestrator
  {
    id: "orchestrator", group: "Create", label: "Orchestrator", title: "Orchestrator plan, recorded example", place: "create",
    html: `${head("Create · Orchestrator", "Orchestrator plan (recorded example)", "Change a step to see its new cost and which steps would run again.")}
      ${grid("Orchestrator steps", "minmax(0,1.3fr) minmax(0,1fr) 120px 130px", ["Step", "Model", "Output tokens", "Cost"], [
        [`<span class="row-title">Brand photo set</span>`, `<span class="row-note">no model call</span>`, `<span class="is-missing">not applicable</span>`, `<span class="is-missing">no model call</span>`],
        [`<span class="row-title">Read the brand photos</span>`, `<span class="mono">text model</span>`, `<span class="mono">1,200</span>`, `<span class="mono">$0.0212</span>`],
        [`<span class="row-title">The product in use</span>`, `<span class="mono">image model</span>`, `<span class="is-missing">not recorded</span>`, `<span class="mono">est. $0.0900</span>`],
      ])}
      ${plate("Change a step", `<p class="row-note">The brand photo set makes no model call, so it has no model or price to change.</p>${offAction("Apply change", "apply-change-why", "Change a step to see its new cost and which steps would run again.")}`)}`,
    notes: {
      does: "Shows a recorded example of a plan: each step, its model, its output tokens and its cost. Changing a step previews its new cost and the steps that would run again.",
      means: "A step with no model call is said so, instead of being shown with a price. A cost that was not recorded is not filled in.",
      checks: ["No red fill: nothing runs from a recorded example", "A step with no model call has no price, and says so", "Estimated costs are labelled est., and recorded ones are not"],
    },
  },

  // ---------------------------------------------------------------- Brand brain
  {
    id: "brain", group: "Create", label: "Brand brain", title: "Brand brain", place: "create",
    html: `${head("Create · Brand brain", "Brand brain", "You can read this brain. Changing it needs a member role.")}
      ${plate("Brand facts from the overview", `<dl class="facts">
        <div><dt>What it sells</dt><dd>Roasted coffee beans and cold brew kits</dd></div>
        <div><dt>Target customer</dt><dd>Empty. Not inferred.</dd></div>
        <div><dt>Country or market</dt><dd>Empty. Not inferred.</dd></div>
      </dl>`)}
      ${plate("Prohibited claims", `<p class="row-note">The brief gate checks every brief against prohibited claims. Keep them current.</p><ul class="rows"><li><div><p class="row-title">No medical claims</p></div></li><li><div><p class="row-title">No price without a source</p></div></li></ul>`)}
      <div class="form-col">
        <div class="field-box"><label class="field-label" for="automation">Automation preference</label><span id="automation" class="field">Review every creative</span><p class="row-reason">Stored only. Nothing is published or approved because this preference is set.</p></div>
        ${offAction("Save brain", "brain-why", "You can read this brain. Changing it needs a member role.")}
      </div>
      ${plate("Versions", `<p class="row-note">No versions stored yet.</p>`)}`,
    notes: {
      does: "Holds what the brand sells, who it is for, what it must not claim, and how it automates. A member changes it; anyone else reads it.",
      means: "Empty means not inferred. The brain is what every brief is checked against, so an empty field is shown rather than guessed.",
      checks: ["No red fill: a viewer cannot save, and the reason is written beside the action", "Empty fields say Empty. Not inferred", "A preference that is stored says nothing else happens because of it"],
    },
  },

  // ---------------------------------------------------------------- Products
  {
    id: "products", group: "Create", label: "Products", title: "Products", place: "create",
    html: `${head("Create · Products", "Products", "Add what you sell, with the claims you may and may not make for it. Those claims are checked whenever a creative is saved.", `<button type="button" class="btn btn-primary">Add product</button>`)}
      ${grid("Products", "minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1.2fr) 100px", ["Product", "May claim", "May not claim", "Updated"], [
        [`<span class="row-title">Harbour Blend, 250 g</span>`, "Single origin, roasted in the week", "Organic, with no certificate on file", "Oct 20"],
        [`<span class="row-title">Cold brew kit</span>`, "Makes 4 litres", "Cures anything", "Oct 14"],
      ])}`,
    notes: {
      does: "Lists what the brand sells. Each product carries the claims it may make and the claims it may not make, and a creative is checked against them when it is saved.",
      means: "A claim the brand may not make is written next to the product, so the person does not learn it from a rejected creative.",
      checks: ["One red action: Add product", "Each product shows what it may and may not claim", "The page says when the claims are checked"],
    },
  },

  // ---------------------------------------------------------------- Pages
  {
    id: "pages", group: "Create", label: "Pages", title: "Pages this brand publishes from", place: "create",
    html: `${head("Create · Pages", "Pages this brand publishes from", "Create a page to give a run its persona, voice, style, account, schedule and trial default. A run without a page keeps its own settings.")}
      <div class="form-col">
        ${fieldBox("page-name", "Page name", "Harbour Coffee, Instagram", "")}
        <div class="field-box"><label class="field-label" for="page-account">Linked account</label><span id="page-account" class="field">Harbour Coffee on Instagram</span><p class="row-reason">The account this page posts to.</p></div>
        <div class="fields-grid">
          ${fieldBox("page-persona", "Persona kit id", "persona_01", "")}
          ${fieldBox("page-voice", "Voice kit id", "voice_01", "")}
          ${fieldBox("page-style", "Style kit id", "style_01", "A run needs a style kit to make a video for this page.")}
          ${fieldBox("page-tz", "Time zone", "", "Needed when a schedule is set.", "Europe/London")}
        </div>
        ${fieldBox("page-times", "Post times", "", "Local times as HH:MM, separated by commas. Leave a day empty for no posts that day.", "09:00, 18:30")}
        ${switchRow("Instagram trial", true, "Post Instagram Reels as a trial first. A person can still turn it off for one post.")}
        <div class="field-box"><label class="field-label" for="page-grad">How the trial graduates</label><span id="page-grad" class="field">Choose a graduation strategy</span><p class="row-reason">MANUAL: a person graduates the reel in the Instagram app. SS_PERFORMANCE: Instagram graduates it if it performs well.</p></div>
        <div class="scr-actions" style="margin-top:8px"><button type="button" class="btn btn-primary">Save page</button></div>
      </div>
      <p class="notice" data-tone="muted">The 3D data explainer style is set on this page. Save the page to keep it.</p>`,
    notes: {
      does: "Sets what a run takes from a page: a persona, a voice, a style, the account it posts to, its schedule and whether Instagram Reels start as trials. A run with no page keeps its own settings.",
      means: "The page is the default for every run it feeds. Times and trials are said in the words the app uses, so a person knows what a trial does.",
      checks: ["One red action: Save page", "A schedule needs a time zone, and the field says so", "The style of a 3D explainer is saved with the page, and the screen says so"],
    },
  },

  // ---------------------------------------------------------------- Market
  {
    id: "market", group: "Insights", label: "Market", title: "Research public examples", place: "insights",
    html: `${head("Insights · Market", "Research public examples", "Reading a public page and adding an example by hand need no setup. The others are optional, use your own developer key, and are never needed to read a page URL.")}
      ${plate("Find public pages and posts", `<p class="row-note">Start with one public page URL. Meridian reads it and stores the text as evidence you can review.</p>
        <div class="inline-field">${fieldBox("page-url", "Public page URL", "", "The text is stored as evidence. It is not part of the brand brain.", "https://example.com/page")}<button type="button" class="btn btn-primary">Read page</button></div>`)}
      ${plate("Stored pages and posts", `<p class="row-note">Each one is evidence you can read. Ranking reads a page only after a member stores it as a competitor observation, so the angle and hook stay a person's decision.</p>
        <ul class="rows">
          <li><div>${word("success", "filled", "Stored")}</div><div><p class="row-title">Founder story, the roastery tour</p><p class="row-note">Page text stored. It is not part of the brand brain.</p></div></li>
          <li><div>${word("muted", "hollow", "Duplicate")}</div><div><p class="row-title">Cold brew, how to</p><p class="row-note">This page's text is already stored for this brand. No duplicate was added.</p></div></li>
        </ul>`)}
      ${plate("Competitors", `<p class="row-note">No competitors yet. Add one you actually compete with.</p><div class="scr-actions" style="margin-top:12px"><button type="button" class="btn btn-secondary">Find candidates</button></div><p class="row-note">No unconfirmed candidates. Discovery never marks a competitor confirmed on its own.</p>`)}
      ${plate("Recurring patterns", `<p class="row-note">Counts describe the collected corpus, not ad effectiveness or causation.</p><p class="row-title">No repeated, confidence-rated ad patterns are stored.</p>`)}
      ${plate("Collect video-ad evidence (Meta Ad Library)", `<p class="row-note">Needs your own Meta developer token. Optional. Collection is capped at 100 ads and 100 MB of stored source video per run.</p>${word("muted", "dashed", "Not set up")}`)}`,
    notes: {
      does: "Reads one public page at a time and stores its text as evidence. Competitors and their creatives are collected only when a person confirms them. Optional sources say they need a key.",
      means: "Evidence is kept apart from the brand brain. Nothing is ranked on a competitor until a person stores it as an observation.",
      checks: ["One red action: Read page", "A duplicate page says so and adds nothing", "The optional source says it needs a key, and that it is optional"],
    },
  },

  // ---------------------------------------------------------------- Intelligence
  {
    id: "intelligence", group: "Insights", label: "Intelligence", title: "Intelligence", place: "insights",
    html: `${head("Insights · Intelligence", "Intelligence", "Counts describe stored posts and creatives, not ad effectiveness or causation.")}
      <dl class="figures">
        <div><dt class="label">Posts analyzed</dt><dd>84</dd></div>
        <div><dt class="label">Avg. engagement rate</dt><dd>3.8%</dd><dd class="cap">Likes + comments + shares / views</dd></div>
        <div><dt class="label">Posting cadence</dt><dd>2.1 days</dd><dd class="cap">Median interval between posts</dd></div>
      </dl>
      <div class="grid-2">
        ${plate("Winning patterns (top decile)", `<p class="row-note">Counts of posts in the top decile that carry each trait.</p><ul class="share-list"><li><span>Short hook</span><span class="mono">6 of 9</span></li><li><span>Product in use</span><span class="mono">4 of 9</span></li></ul><p class="row-note">More post volume needed for decile statistical separation.</p>`)}
        ${plate("Underperforming patterns (bottom decile)", `<p class="row-note">Counts of posts in the bottom decile that carry each trait.</p><ul class="share-list"><li><span>Long intro</span><span class="mono">5 of 9</span></li><li><span>Text only</span><span class="mono">3 of 9</span></li></ul>`)}
      </div>
      ${plate("Competitor whitespace", `<p class="row-title">No whitespace opportunities detected</p><p class="row-note">As market evidence and competitor campaigns are collected, JEV automatically flags high-probability gaps.</p>`)}
      ${plate("System notices", `<p class="row-note">No notices yet.</p>`)}`,
    notes: {
      does: "Shows the stored posts and creatives as counts: how many were analysed, the average engagement, the cadence, what the top and bottom deciles share, and where a competitor has a gap.",
      means: "A count describes what was stored. The screen says it is not an effect, and says when there are too few posts to separate the deciles.",
      checks: ["No red fill: intelligence is read, not acted on", "Each figure names its definition", "An empty result says why it is empty, and what would fill it"],
    },
  },

  // ---------------------------------------------------------------- Calibration
  {
    id: "calibration", group: "Insights", label: "Calibration", title: "Calibration", place: "insights",
    html: `${head("Insights · Calibration", "Calibration", "Proposed changes to the opportunity gate, made from recorded reviewer outcomes. A proposal changes no threshold until an admin approves it.", `<button type="button" class="btn btn-primary">Recompute from outcomes</button>`)}
      ${plate("Active baseline", `<p class="row-title">Version 4, approved Oct 2</p><p class="row-note">Thresholds are stored per workspace, not per brand. The active version is the baseline for every brand in this workspace.</p><p class="row-note">Check this version before you approve another one.</p>`)}
      ${plate("Proposals", `<p class="row-title">No proposal yet</p><p class="row-note">No proposal has been recorded for this brand. A proposal appears here once the reviewer outcomes meet the rules above.</p>`)}
      ${plate("Approved versions", `<p class="row-title">No approved version yet</p><p class="row-note">No version has been approved. The code defaults stay active.</p>`)}`,
    notes: {
      does: "Shows the active thresholds, the proposals made from recorded reviewer outcomes, and the approved versions. Recomputing reads the outcomes again; it changes no threshold.",
      means: "Nothing changes the gate until an admin approves a proposal, and the baseline is what every brand is held to in the meantime.",
      checks: ["One red action: Recompute from outcomes", "A proposal that does not exist says why it does not", "The page says a proposal changes no threshold until it is approved"],
    },
  },
];
