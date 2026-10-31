# Short-form video: what the platforms and the editing practice say

Status: research note, written by the coding loop as task T2 of `.claude/loop/RUN_PLAN.md`. It sets no product behaviour by itself. Its rules become configuration in T12, with the defaults and labels given in section 4.

Retrieved 2026-10-29. Method: web search, standard mode, first for the three platforms' own creator guidance (restricted to their help, ads and creator domains), then for editing practice. Claims below were read from search-result summaries. The source pages were not opened, so each platform figure should be checked on its page before it is quoted anywhere outside the engine.

Not done: no owner reference reel was analysed (Q7). No peer-reviewed study was found on first-three-second retention. Every number that comes only from a vendor blog is marked `hypothesis`.

## 1. What the platforms say

Each claim is paired with the official-domain source it came from. Where the snippet came from a page of the same platform that is not the first link, the page is named.

**YouTube (Help and creator guidance)**

- Audience retention and watch time are the main engagement signals. Creators should study what made a strong video work and reuse those elements, not compare every video with a viral outlier. Source: [YouTube Help, Content tab analytics tips for Shorts](https://support.google.com/youtube/answer/12942217).
- The retention graph reads as follows: a flat line means viewers watch that part to the end, a gradual decline means waning interest, a sharp drop marks where viewers leave or skip, and a spike marks rewatches or shares. Source: [YouTube Help, Measure key moments for audience retention](https://support.google.com/youtube/answer/9314415).
- The intro metric tracks how many viewers remain after 30 seconds. The suggested response is to align the opening with the title and thumbnail and test opening styles. Source: the same two YouTube Help pages, as summarised in the search result.
- Strong material should come early, because the audience shrinks as a video runs. Source: the same pages.

**TikTok (ads and creative guidance, ads.tiktok.com)**

- Prioritise the hook in the first six seconds to boost engagement and watch time. Source: [TikTok for Business, creative best practices for performance ads](https://ads.tiktok.com/resources/help/article/creative-best-practices).
- State the core proposition in the first three seconds, for recall and awareness. Source: the same page.
- Show the product or the point right away, ask a relatable question, make a bold claim, or reveal a surprising visual. Skip long intros and logo animations. Source: [TikTok for Business, video advertising guide for small businesses](https://ads.tiktok.com/business/en/guides/video-advertising-guide).
- Use a less polished, user-generated style. Source: the same guide.
- Read on-screen text at 5 to 10 words per second. Source: a TikTok ads creative page returned by the search (`ads.tiktok.com/business/creativecenter`). The page was not opened, so the exact page is unconfirmed.
- Check the frame-by-frame view in analytics to find where attention drops, and rework the hook if drop-off happens in the first seconds. Source: the same video advertising guide.

**Instagram (creators.instagram.com)**

- Start with a compelling hook in the first three seconds, and track View Rate in Insights. Source: Instagram's creator blog, [best practices for creators](https://creators.instagram.com/blog/best-practices-for-creators), as summarised in the search result. The page was not opened.
- The early part of a video should give viewers something interesting to hold their attention. Source: [Instagram for Creators FAQ](https://creators.instagram.com/faq?locale=en_US), as summarised.
- Distribution signals include watch time, retention, shares, likes and comments, and engagement per viewer is named as the most important factor. Source: the same FAQ.
- Engagement bait and giveaway promotions can limit distribution. Source: the same FAQ.
- Trial reels let a creator test a reel with non-followers before sharing it with followers. Source: the Instagram creator pages returned by the search, not opened. Access is limited.

**Where the platforms agree, and where they differ**

| Point | YouTube | TikTok | Instagram |
| --- | --- | --- | --- |
| The opening matters most | Yes (intro metric) | Yes (6 s, 3 s) | Yes (3 s) |
| Stated window | After 30 s (metric) | 3 s proposition, 6 s hook | 3 s hook |
| Early drop-off is diagnosed from the retention curve | Yes | Yes | Yes (View Rate) |

No platform gives a Shorts or Reels retention benchmark in the material read. YouTube names the 30-second intro metric but gives no target for it.

## 2. Editing practice (third-party, read with care)

These are vendor and creator guidance. None is an official platform position.

- Test an edit with the sound off, then with the sound on. CapCut recommends this and treats captions as part of the pacing, not a finishing touch. Source: [CapCut, short-form video distribution across platforms](https://www.capcut.com/create/short-form-video-distribution-across-platforms). Status: `hypothesis` for any number.
- Tangents and backstory are skipped quickly, so the payoff should come early. Source: [Descript, how to edit short-form video](https://descript.com/blog/article/edit-short-form-video) (editors' comments in the summary).
- Change the visual or the story about every five to seven seconds. Source: [Opus, ideal YouTube Shorts length and format](https://opus.pro/blog/ideal-youtube-shorts-length-format-retention). Status: `hypothesis`, with no methodology given.
- Length advice varies. Shorts guidance ranges from 15 to 40 seconds to 25 to 45 seconds, and Reels guidance from 7 to 15 seconds to 15 to 30 seconds. Status: `hypothesis`. The length is a product choice, not a rule to encode.

## 3. Figures found, not used as defaults

These numbers came from vendor or creator pages with no methodology, or from samples too small to trust. They are recorded so they are not repeated as facts.

- Median YouTube Shorts average view-through near 45%, top decile near 91%. Source: [Quso, video retention benchmarks](https://quso.ai/research/video-retention-benchmarks). Unverified.
- About 60% to 80% of viewers lost before the three-second mark, from a creator analysis of about 1,000 videos. Source: [a Hook Engineering article on dev.to](https://dev.to/bulkdl/hook-engineering-the-science-of-the-first-3-seconds-in-short-form-video-2026-2jp9). Unverified.
- A 0.84 correlation between three-second retention and final views, from one creator's 120-video test. Unverified.
- About 68% of TikTok views and 54% of Reels views start muted, attributed to a 2025 study with no source link. Unverified.
- Captioning gives up to a 40% lift in viewership, attributed to Sonix research. Unverified.
- TikTok-commissioned creative kit studies report +16% watch time from early suspense and a 1.7x view-through rate from surprise. Source: TikTok creative playbook PDFs returned by the search (`ads.tiktok.com/business/library`). These are older, and not checked.
- A 2026 Marketing Trends Congress paper by Florian Dost compares jump-cut styles and transition frequency for engagement. Its text was not read, so no finding is claimed from it. Source: [Marketing Trends Congress, paper by Dost](https://archives.marketing-trends-congress.com/2026/pages/PDF/paper_professor_DOST_HUANG.pdf).

## 4. What the planner can use (for T12)

Each default below is a starting value in configuration, not a proven rule. The learning loop (Bible 16.2) measures them later. Until then each stays labelled `hypothesis` in the configuration file.

| Setting | Proposed default | Label | Basis |
| --- | --- | --- | --- |
| Core proposition by | 3 s | sourced (platform) | TikTok ads guidance, section 1 |
| Latest hook by | 6 s | sourced (platform) | TikTok ads guidance, section 1 |
| Early-retention check point | 30 s | sourced (platform) | YouTube Help metric, section 1 |
| On-screen text rate | 5 to 10 words per second | sourced (platform, page not opened) | TikTok ads creative page, section 1 |
| Longest gap before a visual or story change | 7 s | hypothesis | Opus, section 2 |
| Logo or intro before the hook | none | sourced (platform) | TikTok ads guidance, section 1 |
| Sound-off test | required before approval | hypothesis (practice) | CapCut, section 2 |

The rules that follow from this table, for the plan gate in T12, are:

1. The plan states the proposition inside the first 3 seconds. A plan that does not is flagged at plan time.
2. A plan with no hook by 6 seconds is flagged.
3. Text on screen runs at 5 to 10 words per second, measured on the timed caption lines.
4. A plan with no visual or story change in 7 seconds is flagged as `hypothesis`, and is not refused.
5. Each flag names its label, so a reader can see whether a rule is sourced or a guess.

## 5. Gaps

- No official Shorts, Reels or TikTok organic retention benchmark was found.
- No peer-reviewed study of the first three seconds was found.
- The TikTok on-screen text rate and the TikTok creative playbook figures come from pages whose text was not opened.
- Meta's own hook guidance beyond the creators pages was not confirmed.
- The Dost paper's findings were not read.

The next research step, if the owner supplies reference reels (Q7), is to run the existing `analyze_reference` grammar on them and compare the measured cut times with the defaults above. That is measurement, not a claim.
