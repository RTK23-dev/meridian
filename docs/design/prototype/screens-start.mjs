// Screens that open before a workspace is chosen, and the states a person meets when a page cannot be shown: the invitation, the three
// public pages (product, docs and quickstart), and the not-found, forbidden and admin-only states. Sample copy is taken from the app's own
// routes and components, and is labelled as the proposal where it is not the app's words.
import { globe, head, plate } from "./screens.mjs";

export const START_SCREENS = [
  // ---------------------------------------------------------------- Accept an invitation
  {
    id: "invite", group: "Start", label: "Accept invitation", title: "Accept invitation", shell: "bare",
    html: `<div class="public public-narrow">
      <p class="label">Invitation</p>
      <h1 class="scr-title">Join this workspace</h1>
      <p class="scr-lede">Accept the invitation to add this workspace to your list. The link works once, and it is not shown again after you accept.</p>
      <div class="off-action"><button type="button" class="btn btn-primary">Accept invitation</button></div>
    </div>`,
    notes: {
      does: "Asks for one decision: accept the invitation that came by email. Accepting adds the workspace to the person's list, and the page then offers one way forward.",
      means: "The link works once, and the page says so before the button is pressed. Nothing is joined by reading the page.",
      checks: ["One red action: Accept invitation", "A link with no token shows its reason and turns the action off, with the reason beside it", "After acceptance, the status says what was added and links to the workspace"],
    },
  },

  // ---------------------------------------------------------------- Product page
  {
    id: "product", group: "Start", label: "Product page", title: "Product, public page", shell: "bare",
    html: `<div class="public">
      <p class="label">Meridian · Product</p>
      <h1 class="scr-title">Creatives made from evidence, reviewed before they go out</h1>
      <p class="scr-lede">Meridian keeps the facts a brand must not contradict, finds opportunities in evidence it can cite, makes the creatives, and learns from what was measured. Each stage is a screen, and each screen says what it has and what it is missing.</p>
      <div class="cover-grid">
        <article class="note-plate"><p class="label">The loop</p><p>The Factory runs these stages in order. A run stops at any stage that needs a person, and the stage says why.</p><p class="cap">Source, grade, angle, plan, produce, gate, approve, publish, measure, learn.</p></article>
        <article class="note-plate"><p class="label">Two ways in, one core</p><p>Research-led production, or direct creation from a brief, a reference or an upload. Both use the same brands, evidence, plans, assets, runs, reviews and measurements.</p></article>
      </div>
      <div class="scr-actions"><button type="button" class="btn btn-primary">Start the quickstart</button><button type="button" class="btn btn-secondary">Read the docs</button></div>
    </div>`,
    notes: {
      does: "Says what Meridian is, in one paragraph, then shows the loop and the two ways in. Two actions lead to the quickstart and to the docs.",
      means: "A visitor learns what stops a run and what each stage keeps, before any sign-up. The page makes no claim it cannot point to.",
      checks: ["One red action: Start the quickstart", "The loop names the stages in their real order", "The list of what Meridian does not do is not drawn here. Its text should be copied from the page, not written again"],
    },
  },

  // ---------------------------------------------------------------- Docs page
  {
    id: "docs", group: "Start", label: "Docs", title: "Docs, public page", shell: "bare",
    html: `<div class="public">
      <p class="label">Meridian · Docs</p>
      <h1 class="scr-title">Docs</h1>
      <p class="scr-lede">What the words in the product mean, how a deployment runs, and where the full reference lives in the repository.</p>
      ${plate("Concepts", `<p class="row-note">The page defines the product's words. Its text is not reproduced in this walkthrough.</p>`)}
      ${plate("Running a deployment", `<dl class="facts">
        <div><dt>A local trial</dt><dd>Needs Node.js 22 and no database server. Data is kept in .data/pglite.</dd></div>
        <div><dt>A production deployment</dt><dd>Needs PostgreSQL 16 and a database URL. Production refuses to start without one.</dd></div>
        <div><dt>Provider keys</dt><dd>Saved in Settings, then General, by an admin. They are stored encrypted and never shown again.</dd></div>
      </dl>`)}
      ${plate("Reference in the repository", `<p class="row-note">The full reference is in the repository, not on this page.</p>`)}
    </div>`,
    notes: {
      does: "Explains the words, the two ways to run Meridian, and where to keep keys. The reference stays in the repository and is linked from here.",
      means: "A person running Meridian can see what production needs before starting it. Keys are said to be stored encrypted and never shown again.",
      checks: ["No red fill: the page has no action to take", "Each run mode names what it needs", "Provider keys say who can save them, and that they are not shown again"],
    },
  },

  // ---------------------------------------------------------------- Quickstart page
  {
    id: "quickstart", group: "Start", label: "Quickstart", title: "Quickstart, public page", shell: "bare",
    html: `<div class="public">
      <p class="label">Meridian · Quickstart</p>
      <h1 class="scr-title">Quickstart</h1>
      <p class="scr-lede">Run Meridian on your own machine in a few minutes. The first screen to complete is the brand brain.</p>
      ${plate("The first run", `<p class="row-note">Start with the brand brain. Nothing can be planned until a brand exists, and the brain holds what the brand must not contradict.</p>`)}
      <div class="scr-actions"><button type="button" class="btn btn-primary">Start the quickstart</button><button type="button" class="btn btn-secondary">Read the docs</button></div>
    </div>`,
    notes: {
      does: "Says how long a first run takes, and that the brand brain comes first. Two actions lead on: the quickstart itself, and the docs.",
      means: "A first-time person knows what to do first, and what waits until a brand exists.",
      checks: ["One red action: Start the quickstart", "The first step is named once, and nothing else is asked yet", "The docs link is secondary, so it does not compete with the quickstart"],
    },
  },
];

export const STATES_SCREENS = [
  // ---------------------------------------------------------------- Not found
  {
    id: "not-found", group: "States", label: "Page not found", title: "Page not found", place: "home",
    html: `${head("Home", "Page not found")}
      <div style="display:grid;justify-items:center;gap:16px;padding:56px 0;text-align:center">
        ${globe(104, false)}
        <h2 class="empty-title">Page not found</h2>
        <p class="scr-lede" style="margin:0">The address may be mistyped, or the page has moved.</p>
        <div class="scr-actions"><button type="button" class="btn btn-secondary">Back to the overview</button></div>
      </div>`,
    notes: {
      does: "Keeps the app's shell, so the navigation is still there. It says why the page is missing, and offers the way back.",
      means: "A wrong address is not a dead end. The person is one step from somewhere known.",
      checks: ["No red fill: the way back is secondary", "The shell and its places stay in view", "The reason is one sentence, and it names both causes"],
    },
  },

  // ---------------------------------------------------------------- Forbidden
  {
    id: "forbidden", group: "States", label: "No access", title: "You cannot open this page", place: "home",
    html: `${head("Home", "You cannot open this page")}
      <div class="plate-block" style="max-width:640px">
        <p class="row-title">Your role does not allow it</p>
        <p class="row-note">Your role in this workspace does not allow it. Ask a workspace admin if you need access.</p>
        <div class="scr-actions" style="margin-top:14px"><button type="button" class="btn btn-secondary">Back to the overview</button></div>
      </div>`,
    notes: {
      does: "Shown when the account may not open a screen, for example after a permission refusal. It says so, and it says who can give access.",
      means: "A person is not left guessing whether the page is broken. They know it is their role, and who to ask.",
      checks: ["No red fill: the way back is secondary", "The reason names the role and the person who can change it", "No data from the page is shown"],
    },
  },

  // ---------------------------------------------------------------- Admin only
  {
    id: "admin-only", group: "States", label: "Admin only", title: "Usage and cost is for workspace admins", place: "settings",
    html: `${head("Settings · Usage & cost", "Usage &amp; cost")}
      ${plate("Only a workspace admin can open this", `<p class="row-title">Usage and cost is for workspace admins</p>
        <p class="row-note">Your role in this workspace is member, so these records are not loaded for you. Ask a workspace admin if you need them.</p>`)}`,
    notes: {
      does: "Replaces the records with one notice that names the role and the screen. No figures are loaded for a person who may not see them.",
      means: "A member does not see a cost or a log they may not read, and is told why, instead of seeing an empty table.",
      checks: ["No red fill", "The notice names the screen and the role", "No figure, table or export is loaded or shown for this role"],
    },
  },
];
