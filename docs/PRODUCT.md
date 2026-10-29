# Product

Meridian turns a brand's own facts and evidence into creatives, decides which ones may go out, delivers them, and learns from what
happened. Each step is a screen, and each screen says what it has and what it is missing.

## The workflow

Setup starts on the **Setup guide**: create a brand, then choose a decision engine and save its key. Everything after that is optional and
sits behind "Open this step". Work happens on the **Content** page, one per brand, with these sections: Create, Batch, Ideas, Review, Library,
Publish and Results. Batch now opens on Video batches: an admin can choose a reusable draft with an uploaded reference video, attached Market evidence and plain instructions, create 2–20 original draft variations with a total budget split per video, then explicitly start the batch and inspect each item's real status/review/export. The research-led Factory remains an advanced tab. The live-provider and owner acceptance gates are still open.

1. **Brand brain.** The facts the system must not contradict: positioning, audience, voice, rules and assets. Four fields are required
   for generation: positioning, target customers, tone and prohibited claims. Saving never replaces a field the person did not change.
   Empty fields stay empty; nothing is inferred.
2. **Products.** The products the brand sells. A brief names one.
3. **Market and research.** Public pages and the connected sources the deployment has configured. Each item keeps where it came from. A
   source that is not configured is listed as such, with the reason. The default Market view starts with one public page URL, which
   needs no key, and shows each run as one outcome: new examples, nothing new, blocked, partly worked, or nothing read. Per-source rows
   sit behind "Show source details". Searching by phrase is separate and optional (PROVIDERS.md, "What a source key does on Market").
4. **Opportunities.** Angles drawn from the evidence, each listing the evidence it cites.
5. **Studio.** A brief is judged before anything is generated. An approved brief can make an image, or a video through Gemini Omni, Higgsfield, or a manual cloud folder. Hypit is not connected (see `docs/HYPIT_LICENSE.md`). A missing provider is shown as not connected. Each variant keeps its evidence, its decision, and its review.
6. **Library.** The creatives that exist, with their media and their lineage. An export package for manual posting is made here.
7. **Publishing.** A connected Facebook Page, Instagram, YouTube, or TikTok account can receive an organic post. Paid ads are created paused. A channel with no connection says so, and nothing is sent. A delivered video can also be repurposed into reviewed variations: an admin can upload one to the ad account, create one paused ad from it, post it to one Facebook Page, or read its metrics. Each step is a separate action, and approval never publishes (FACTORY.md, "Repurposing a delivered video").
8. **Learning.** Measured results are stored only when they were observed. The next recommendation can change. A grade already stored is not rewritten when calibration changes.

## Roles

Owners and admins can change settings, keys and brands. Members can create and review. Viewers can read. Every mutation checks the
role on the server, not only in the screen.

## What a person sees when something is missing

Nothing is hidden and nothing is invented. A missing key, connection or piece of evidence is named on the screen where the work would
happen, with the step that fixes it. A button that cannot act says why, next to it.
