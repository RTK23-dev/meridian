// The public site's navigation and copy, as data. No React here, so the copy can be tested directly. Every statement is one the product
// makes in its own docs (docs/PRODUCT.md, docs/SETUP.md, docs/PROVIDERS.md, AGENTS.md). Nothing here is a metric, a price, a customer
// or a testimonial: a number this site showed would be a number the product had not measured.

export const PUBLIC_PAGES = ["/product", "/docs", "/quickstart"] as const;
export type PublicPath = (typeof PUBLIC_PAGES)[number];

export const PUBLIC_NAV: ReadonlyArray<{ to: PublicPath; label: string }> = [
  { to: "/product", label: "Product" },
  { to: "/docs", label: "Docs" },
  { to: "/quickstart", label: "Quickstart" },
];

/** The repository that holds the reference docs. The docs page links to files on its main branch. */
export const REPO_URL = "https://github.com/RTK23-dev/meridian";

export type WorkflowStep = { id: string; label: string; what: string };

/** The eight steps of the workflow, in the order docs/PRODUCT.md gives them. */
export const WORKFLOW: readonly WorkflowStep[] = [
  {
    id: "brand-brain",
    label: "Brand brain",
    what: "The facts the system must not contradict: positioning, audience, voice, rules and assets. Empty fields stay empty. Nothing is inferred.",
  },
  { id: "products", label: "Products", what: "The products the brand sells. A brief names one." },
  {
    id: "research",
    label: "Market and research",
    what: "Public pages and the connected sources the deployment has configured. Each item keeps where it came from. A source that is not configured is listed with the reason.",
  },
  { id: "opportunities", label: "Opportunities", what: "Angles drawn from the evidence, each listing the evidence it cites." },
  {
    id: "studio",
    label: "Studio",
    what: "A brief is judged before anything is generated. An approved brief can make an image or a video. A missing provider is shown as not connected.",
  },
  { id: "library", label: "Library", what: "The creatives that exist, with their media and their lineage. An export package for manual posting is made here." },
  {
    id: "publishing",
    label: "Publishing",
    what: "A connected Facebook Page, Instagram, YouTube or TikTok account can receive an organic post. Paid ads are created paused. A channel with no connection says so, and nothing is sent.",
  },
  {
    id: "learning",
    label: "Learning",
    what: "Measured results are stored only when they were observed. The next recommendation can change. A grade already stored is not rewritten when calibration changes.",
  },
];

/**
 * Where a stage stops for a person, or holds money or a post. A label names it in words, so the signal never relies on colour alone.
 */
export const SIGNAL_LABEL = {
  review: "Missing evidence goes to review",
  decision: "A person or a set policy decides",
  paused: "Paid ads are created paused",
} as const;
export type StageSignal = keyof typeof SIGNAL_LABEL;

export type FactoryStage = { id: string; name: string; what: string; signal: StageSignal | null };

/**
 * The Factory's stages, in the order AGENTS.md gives them. Each line restates what docs/FACTORY.md and AGENTS.md say the stage does.
 */
export const FACTORY_STAGES: readonly FactoryStage[] = [
  { id: "source", name: "Source", what: "Finds public pages and ads for the niche. Each item keeps where it came from.", signal: null },
  { id: "grade", name: "Grade", what: "Scores each ad from what its source reported. A score is a score until a calibration report says otherwise.", signal: null },
  { id: "angle", name: "Angle", what: "Picks what to make next from the graded evidence, and names the evidence it used.", signal: null },
  { id: "plan", name: "Plan", what: "Turns the chosen angle into a plan for each variant. Each variant changes one attribute.", signal: null },
  { id: "produce", name: "Produce", what: "Provider jobs make the media. A provider with no price or no connection is not called.", signal: null },
  {
    id: "gate",
    name: "Gate",
    what: "Originality, claims, policy and rights checks can block a creative. Missing evidence goes to review, never to a pass.",
    signal: "review",
  },
  { id: "approve", name: "Approve", what: "A person approves each creative, or a policy the brand has set does.", signal: "decision" },
  { id: "publish", name: "Publish", what: "Organic posts go to a connected account. Paid ads are created paused.", signal: "paused" },
  { id: "measure", name: "Measure", what: "Stores observed results only, pulled on a schedule for creatives that have a publishing receipt.", signal: null },
  { id: "learn", name: "Learn", what: "Updates the brand's patterns from measured outcomes. A run finishes only when its own creatives have a measured outcome.", signal: null },
];

/** What both ways of creating share, from AGENTS.md. Each is a record a person can open, not a separate pipeline. */
export const SHARED_CORE: readonly string[] = [
  "Brands",
  "Evidence",
  "Plans",
  "Assets",
  "Runs",
  "Reviews",
  "Publishing receipts",
  "Measurements",
  "Learning",
];

/** The two ways to create, from AGENTS.md. Both share the same brands, evidence, plans, assets, reviews and learning. */
export const TWO_WAYS: readonly { id: string; label: string; path: string; start: string }[] = [
  {
    id: "factory",
    label: "Factory: research-led runs",
    path: "Source, grade, angle, plan, produce, gate, approve, publish, measure, learn.",
    start: "Starts from evidence about the niche that Meridian has gathered and can cite.",
  },
  {
    id: "studio",
    label: "Studio: direct creation",
    path: "Brief, reference or upload, plan, generate, revise, review, export or publish.",
    start: "Starts from a brief you write, a reference you bring, or a file you upload.",
  },
];

/** What a person can rely on. Each line is a behaviour the product enforces, and each one is covered by a test or a docs page. */
export const COMMITMENTS: readonly string[] = [
  "Nothing is invented. A missing key, connection or piece of evidence is named on the screen where the work would happen, with the step that fixes it.",
  "A service that is not connected says so. It does not report success.",
  "Paid ads are created paused, and Meridian never switches them on.",
  "Keys are saved encrypted on the server, and they are never shown again.",
  "Every change checks the role on the server, not only in the screen.",
  "A score is a score until a calibration report says otherwise.",
];

export const ROLES: readonly { label: string; what: string }[] = [
  { label: "Owners and admins", what: "Change settings, keys and brands." },
  { label: "Members", what: "Create and review." },
  { label: "Viewers", what: "Read." },
];

export type QuickstartStep = { id: string; title: string; body: string; command?: string };

/** The first run, in the order docs/SETUP.md gives it. A step never claims an outcome the product does not produce. */
export const QUICKSTART: readonly QuickstartStep[] = [
  {
    id: "install",
    title: "Install Node.js 22 and start Meridian",
    body: "Node.js 22 is all a local trial needs. The first start installs the dependencies, creates .env from .env.example and generates its secrets into it. It never overwrites an existing .env and never prints a secret.",
    command: "git clone https://github.com/RTK23-dev/meridian.git\ncd meridian\nnpm run dev",
  },
  {
    id: "open",
    title: "Open the app and create an account",
    body: "The app runs at http://127.0.0.1:8080. Open it, create an account and sign in.",
  },
  {
    id: "workspace",
    title: "Create a workspace and a brand",
    body: "A workspace holds its members, settings and keys. Each brand keeps its own facts, products, evidence and creatives.",
  },
  {
    id: "brain",
    title: "Complete the brand brain",
    body: "Four fields are required before anything can be generated: positioning, target customers, tone and prohibited claims. Meridian does not fill them in for you.",
  },
  {
    id: "evidence",
    title: "Gather evidence",
    body: "Add the brand's products, then look at Market and research. A source that is not configured is listed with the reason, and every item keeps where it came from.",
  },
  {
    id: "keys",
    title: "Connect the providers you use",
    body: "Open Settings, then General, to save a provider key for the workspace. Only an admin can save one. A key is stored encrypted and is never shown again. A provider with no key stays not connected.",
  },
  {
    id: "make",
    title: "Make and review a creative",
    body: "Accept an opportunity to start a brief in Studio. The brief is judged before anything is generated. Review each variant, then approve or reject it. An approved variant can be exported or queued to publish.",
  },
  {
    id: "learn",
    title: "Publish, then record what happened",
    body: "Publishing needs a connected account for the brand, and nothing is sent without one. Measured results are stored only when they were observed, and the next brief can use them.",
  },
];

export type DocsConcept = { term: string; definition: string };

export const CONCEPTS: readonly DocsConcept[] = [
  { term: "Workspace", definition: "The space that owns the brands, members, keys and settings. Roles are set here." },
  { term: "Brand", definition: "One set of facts, products, evidence and creatives. Work is kept per brand." },
  { term: "Brand brain", definition: "The facts a brand must not contradict. Positioning, target customers, tone and prohibited claims are required for generation." },
  { term: "Evidence", definition: "Public pages, posts and ads gathered from the market. Each item keeps its source, and an item with no source is not used." },
  { term: "Opportunity", definition: "An angle drawn from stored evidence. It lists the evidence it cites, and it is accepted or set aside by a person." },
  { term: "Brief", definition: "The written request a creative is made from. A brief is judged before anything is generated." },
  { term: "Variant", definition: "One creative made from a brief. Each variant keeps its evidence, its decision and its review." },
  { term: "Review", definition: "A decision waiting for a person, such as a brief or a variant. Reviews are shown in one list per brand." },
  { term: "Publishing", definition: "Organic posts go to a connected account. Paid ads are created paused. An export package works without any account." },
  { term: "Learning", definition: "Measured results, stored when they were observed, that inform the next brief." },
];

export type RepoDoc = { path: string; label: string; what: string };

/** Reference docs in the repository. Each path is checked against the disk by a test, so a moved file breaks the test, not the link. */
export const REPO_DOCS: readonly RepoDoc[] = [
  { path: "README.md", label: "README", what: "What Meridian is and how the parts fit together." },
  { path: "docs/SETUP.md", label: "Setup", what: "Running it on a laptop or a server, the local trial, and deploying." },
  { path: "docs/PROVIDERS.md", label: "Providers", what: "Which keys exist, and which stay off until you opt in." },
  { path: "docs/PRODUCT.md", label: "Product", what: "The workflow, the roles and what a person sees when something is missing." },
];

export function repoDocUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}
