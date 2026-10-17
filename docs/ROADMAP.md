# Roadmap

What is still open in this release. Each item says whether it is built and verified, built but unverified, or not built. Nothing here is listed as finished unless it is verified.

## Video engine and Factory: open now (2026-10-17)

Sources: the newest entries of [engine/PHASE_LOG.md](engine/PHASE_LOG.md) (the 2026-10-17 final code pass, which supersedes the open list of the pre-release entry), the open items in
[engine/VIDEO_ENGINE_BIBLE.md](engine/VIDEO_ENGINE_BIBLE.md) section 20, and [FACTORY.md](FACTORY.md#not-built-yet). Engine phases E1 to E6
are code complete on recorded fixtures. No phase is done until its live acceptance test (Bible section 19) is recorded. Agents hold no
keys (NORTH_STAR decision 1), so every live step is the owner's.

### Live runs (owner)

- **Content Factory brief run.** A brief request with a reference video has never run end to end. The run needs OpenRouter, Deepgram (key
  and project id), Google Drive, the media functions (in-process on the worker, or an HTTPS base URL) and a HyperFrames key. The owner runs
  it and records the artifact ids and costs.
- **Video engine acceptance, E1 to E6.** Each phase needs a recorded live run with its artifact ids, costs and output. None is recorded.
  The reason is the keys: agents hold none. The E1 run is in [scripts/engine/README.md](../scripts/engine/README.md).
- **Production shots.** Cartoon and other generated shots stay NOT_CONNECTED until `MEDIA_FUNCTIONS_BASE_URL` is set, the workspace has a
  Google Drive connection and it has an OpenRouter key. Some video models stay NOT_CONNECTED even then, and so do speech and images that
  are not PNG. The reason is recorded in the PHASE_LOG (2026-10-15, final pass).
- **Factory live paths.** Discovery through Apify, the Shopify webhook, Instagram trial reels and sleep mode are tested on fixtures only.
  They need an Apify key, a connected Shopify shop, a live Instagram account, and a running scheduler for sleep mode. None has a recorded
  live result.

### Owner items

- **Keys and database URLs.** OpenRouter, HeyGen, Anthropic and Apify keys, the Shopify secret, `DATABASE_URL`, and `MERIDIAN_PG_TEST_URL`
  for the PostgreSQL tests. Reason: agents hold no keys, and the database tests run on PGlite until a server is given.
- **Media functions URL and host.** `MEDIA_FUNCTIONS_BASE_URL`. Reason: the detectors (captions, zoom, loop, shake, speed ramps) stay
  NOT_CONNECTED until it is set. The functions carry no credential, so the host must be restricted before the URL is set.
- **Platform file-size limit.** `thresholds.render.platformMaxBytes` is still null. Reason: the render integrity gate fails closed on a null
  limit, so no render passes it until the owner sets one.
- **HyperFrames price.** Reason: the render stays fail-closed until its price per minute is known. The sources disagree (Bible 20.3, item 1).
- **Apify plan price.** Reason: the cost per 1,000 results is null, so no discovery cost is estimated.
- **`image.edit` price.** Reason: stop-motion shots are token-priced, so stop motion is refused until the price is set.
- **Stop-motion length.** The frame floor is 24 (the Bible's number), and a shot longer than the frame limit needs a lower frame rate. Reason:
  that rate is the owner's decision. Planned stop-motion shots are about 1.9 to 3.0 seconds today.
- **`stopmotion.player` confirmation.** Reason: the owner-facing confirmation of the component is still open.
- **Shotstack credential.** The gateway has a Shotstack route, but Meridian's credential resolver has no Shotstack category, so the fallback
  renderer is not connected. The PHASE_LOG (2026-10-15) lists the credential slot as an owner item.
- **Speech-to-text (Bible 20.2).** Deepgram Nova-3 is chosen (owner decision 2026-10-16). Its price, $0.0043 per minute, is third-party and
  unverified. The bill is read from Deepgram's request lookup, which needs the key and the project id on the deployment. Word timestamps
  and music robustness are not yet verified live.
- **Narration model (owner decision 2026-10-17).** OpenRouter's `elevenlabs/eleven-v4`, with `google/gemini-3.8-flash-tts` as fallback, both
  read from OpenRouter's public listing. The request shape, the generation id and `total_cost` are unverified (`engine/PROVIDER_APIS.md`,
  Speech).
- **Background removal, upscaling and lip-sync vendors (Bible 20.2).** Reason: not chosen.
- **Music source (Bible 20.2).** Reason: the licensed library and its terms for social use are not chosen.
- **Disclosure wording and placement (Bible 20.2).** Reason: the standard for AI presenters is not decided. Until it is, the
  `paidPartnership` disclosure defaults to on.
- **Stock licence for commercial social use (E2).** Reason: the Pexels and Pixabay terms (Bible 20.3, item 5) are the owner's to confirm.
- **Two `critic_final` craft items.** Reason: proposed in the 2026-10-15 wave, awaiting the owner's confirmation.
- **Product naming in variant copy.** Reason: the variant writer names the product, but the planner's "No names" rule points the other way.
  The owner decides which rule holds.
- **EDL audio contract step.** Reason: a changed-lines-only voice needs `audio.voice` as an ordered list in the EDL and a `spliceAudio` media
  function, which the owner must approve. Until then a variant's voice is a full re-speak, which is a recorded deviation.
- **Instagram trial graduation signal.** Reason: Meta documents no field that reports graduation. The feed step stays a person's action until a
  graduation is observed.
- **Merging PR #71.** Reason: the PHASE_LOG lists the merge as the owner's.

### Engineering work still open

- **Held-call reconciler.** The scheduler inserts `engine.reconcile_holds` for each organization that does not already have the row. Disabling the row still disables it. A held call with no provider reference is still an operator item.
- **Image references and frames.** The `input_references` shape matches OpenRouter's documented shape (read 2026-10-15), but the reference
  limit (`IMAGE_REFERENCES_MAX`) is unverified until a live call is made.
- **Chain end-to-end test.** It uses stand-ins, which are listed in `src/engine/jobs/handlers/STATUS.md`.
- **Engine checklist artifact.** Not ticked in the 2026-10-15 completion pass (session limit, as the PHASE_LOG records).
- **Bible 20.3 verification, first two weeks.** Still open: the HyperFrames price, speed and component fidelity (item 1); which OpenRouter video
  models accept a first and a last frame (item 2, the harness exists, the live step does not); Avatar IV through OpenRouter, which is
  NOT_CONNECTED because no verified API exists (item 3); speech-to-text word timestamps (item 4); Pexels and Pixabay licence terms (item 5);
  Haiku pricing and whether OpenRouter passes through prompt caching and batch (item 6).

### Factory items

The Factory's open items are listed in [FACTORY.md](FACTORY.md#not-built-yet). They are: video cost is not metered spend; Factory images run
no preflight or claim check; learning is not re-run on a schedule; no cross-surface proposals; a re-grade overwrites the stored grade; organic
outcomes are one per post; perception reads are not metered; the Factory Line editor is saved but read by no job; a live paid publish needs a
Facebook Page id and a destination link; uploads are not connected to Gather; a stored grade keeps its old threshold until its ad is graded
again; and live outcomes are missing, because organic channels return no metrics.

## Built, not verified against the live service

- **Live posting through connected accounts.** Facebook Page posts, YouTube Shorts uploads, Instagram Reels and TikTok regular videos go out through a connected account. Instagram and TikTok fetch the video through a signed link to the approved creative, valid for 15 minutes (`/api/media-links/:creativeId`). A receipt is stored only when the platform returns an id: TikTok reports published only with the post id it returns, which a private post does not carry. TikTok posts are private until TikTok approves the app. No request was made to any of these live APIs in this release. Tests use a scripted transport.
- **Google Drive connect from the app.** Workspace admins connect with OAuth (`drive.file`) from Settings, and can disconnect from the same panel. Not exercised against a live Google account.
- **Live source calls.** YouTube, SerpAPI and Meta Ad Library have request code and tests against fixtures of their documented response shapes. No live key was used.
- **Discovery runs in the interface.** The Market screen starts a run and lists recent runs with each source's state.
- **Calibration report.** It says "not calibrated" until 200 usable outcomes exist, and shows no numbers before then.
- **Per-question calibration of the grading questions.** A brand's threshold for each probability grading question is calibrated from its own measured outcomes, once it has the minimum (100 per question). The method, its constants and what is not built are in [FACTORY.md](FACTORY.md#calibration-per-brand-and-question). The owner has accepted the constants for now; they will be reviewed once real measured outcomes exist. A calibrated threshold can only raise the registry's bar. The tests were written for CI and have not been run from this branch. No live metric was pulled while building this, so every brand is uncalibrated in this build.
- **Video frame selection.** `video/scene-frames.ts` picks the highest-relevance scene per quarter from the scored timeline. The production image checks do not use it yet.

## Open

- **Instagram Reels token scope.** The connected-account check does not read `instagram_content_publish`, so a token without it fails at Meta, not in Meridian. The media route is built (see above).
- **Provider lookup for held budget.** Held budget is released only when a provider's own lookup confirms it holds no job for the submission. None of the wired providers has a documented lookup for a submission whose response never arrived: Google's Interactions API (image and omni) finds an interaction only by its server id, Higgsfield's documented paths use a request id, and Hypit's status path is by job id. Until one is registered in `SUBMISSION_LOOKUPS`, every such hold stays for an admin. Deepgram's request lookup and OpenRouter's generation lookup settle held calls that carry a provider
  reference (migration 0101, `engine.reconcile_holds`); a submission with no reference still waits for an admin.
- **TikTok app audit.** Until TikTok audits the app, posts are private and TikTok returns no public post id, so this channel reports them as unconfirmed. Check the audit status before expecting a published receipt.
- **Workspace login and brand destination are different records.** Integrations stores the Meta, Google, and TikTok login for the workspace. Connected accounts names the page or ad account a brand uses. Signing in from a brand returns to that brand. Paid ads use the workspace login plus the ad account ID. Page posts still need the page token, because the ads login does not include it. Live acceptance of either path is still an owner run.
- **YouTube upload visibility.** Uploads default to public. Confirm that default before release.
- **Drive folder visibility.** Under `drive.file`, a workspace connected by OAuth sees only folders the app created. A `MERIDIAN_DRIVE_FOLDER_ID` created elsewhere will refuse uploads from that token. Decide whether the app creates the folder at connect time.
- **Drive export packages.** No code writes export packages to Drive, so no export row exists for them.
- **Canonical-URL dedupe.** Not indexed. Link-less cards share their page's URL, so a unique index would refuse distinct records. Page evidence is keyed by content hash only. Brand-scoped content-hash indexes are in migration 0059.
- **JEV/provider transport hardening (implemented on this branch, pending CI verification).** The shared TypeSafe transport now aborts requests after 30 seconds, refuses redirects, and caps response bodies at 2 MiB. OAuth redirects are checked against `MERIDIAN_ALLOWED_OAUTH_ORIGINS` (or `APP_URL`/`PUBLIC_APP_URL`), and OAuth state is atomically claimed before exchanging the code. Drive folder listing and manual-cloud scans now distinguish API failures from an empty folder. Held-reservation reconciliation now asks the authoritative plan settlement path to settle its associated plan. Rate limiting no longer trusts forwarding headers unless `MERIDIAN_TRUST_PROXY_HEADERS=true`; deployments behind a trusted proxy must set this explicitly and restrict direct origin access.
- **Calibration floors are different counts, not one missing number.** A threshold proposal needs 30 reviewer rows (`calibration/propose.ts`). The calibration report shows no measurement before 200 usable outcomes. A grading question calibrates at 100 outcomes for that question, and a calibrated threshold can only raise the bar. Do not collapse these into one constant.
- **Fixed defaults in scoring.** Opportunity workflow coverage is now 1 when a product and a known template exist, 0.5 when only a product exists, and 0 when no product is recorded. The heuristic grader refuses a missing score instead of filling 0.5. The calibration report leaves out a row with no score. Still open: `grading/engine.ts` winner-score evidence uses 0 for an unknown count of countries or platforms, which is a count rather than a rate.
- **Content Factory v2 (NORTH_STAR section 8, items 1 to 11) is built on recorded fixtures.** Run settings, the stop points, approvals, grading
  with the caps and kill switch checked before each engine call, Gather (including Instagram volume through Apify), the video engine as a
  video producer, publishing and measurement on both surfaces, learning per surface, theme pages, trial reels, Shopify attribution and sleep
  mode are described in [FACTORY.md](FACTORY.md). The live gaps are listed there under "Not built yet". Screenshots of the changed screens
  are in [feature-screens](feature-screens/README.md). The PHASE_LOG records no run of the button audit for these changes. The standalone page at `/content-factory` (brief requests, file and
  source attachments, the decision feed) is built on fixtures; see FACTORY.md, Content Factory page.
- **JEV grade for the Factory.** The five grading questions have specs in the registry (`market.competitive_strength.v1`,
  `production.reproducibility.v1`, `creative.brand_fit.v1`, `brand.positioning_fit.v1` and `safety.policy_risk_level.v1`). The thresholds of
  the first two are marked uncalibrated, so their grades go to review until the brand has its own calibrated report. The per-brand
  calibration path is built (see above). The owner accepted its method and constants for now (NORTH_STAR section 9), and they are reviewed
  once real measured outcomes exist. A calibrated threshold applies only when it is at least the registry's approve threshold, so it can only
  raise the bar; see FACTORY.md.
- **Spend caps count priced metered spend only.** A decision whose engine reports tokens writes a row to `factory_costs`, with its tokens. Its dollar cost is written only for a model in the price table (`gpt-6-luna`, the OpenAI Decisions default); any other model is tokens only and is not counted by caps. A provider call that reports no cost is not counted either. See [FACTORY.md](FACTORY.md).
- **Organic live metrics.** The measurement pull reads Instagram Reels, YouTube Shorts and TikTok through each channel's stored token and stores only observed values. Instagram and TikTok are not verified live, and Facebook Page is not implemented (see FACTORY.md, Measure).
- **Audit log error.** The baseline fixture shows a generic error on the audit log. The cause is not reproduced; the Details text from a running workspace is needed.
- **Environment reads outside the contract.** `GOOGLE_ADS_DEVELOPER_TOKEN` has no entry in `credentials/contract.ts`. Other reads sit outside it in `discovery/cyclone-scout-adapter.ts`, `settings/provider-config.ts`, `notifications/email.ts`, `factory/sources.ts`, `embeddings/external.ts`, `system.ts`, `routes/api/webhooks/receive.ts` and `storage/google-auth.ts`.
- **Cyclone console field.** The Cyclone gateway is configured by the deployment's environment only.
- **Lint warnings.** Four `react-refresh/only-export-components` warnings remain in existing files. They are not errors.
- **Static review, P2 items still open** (from the review of `01307e8`): video-DNA frame labelling bypasses the perception provider. Routing it needs a schema change, which is still an owner decision. Rate limits are shared across instances when `DATABASE_URL` is set (migration `0103`); a deployment with no database URL is one process and keeps the in-memory window. The learned-pattern erasure and the `minConfidence` skip are closed.
- **Production decision evidence.** The Factory and Studio video visual decisions now read one representative frame selection (`decisions/frames.ts`, `FRAME_SELECTION_VERSION`) and record its frame ids and timestamps. The engine's review code (`src/engine/review`) does not use this selection; it keeps its own frame times. Whether it should is an owner decision, because the Bible governs `src/engine/`.
- **Production preflight and the claim gate.** Connected: a video spec passes `evaluateProductionPreflight` in `production/submit.ts` before any provider's `submitJob`. A Factory image passes `evaluateImagePreflight`, which requires a hook or a script and does not apply the 1–300 second video rule. A BLOCK records the refusal and no provider is called. The copy check on a Factory image runs the deterministic prohibited and unsupported claim rules before spend; a hit stops the image. The engine claim question is still asked on the Studio and job paths, not before a Factory image provider call, because an uncalibrated answer must not be treated as a pass and must not block a still that only needs review. Still open: (1) a Factory image is not sent through `judgeCopy`'s engine gate. (2) The claim question's evidence scope has no stored allowed claims. (3) A brand with no stored prohibited claims gets no claim judgment, because the question abstains without its evidence. (4) A Factory video whose variant has an empty hook is refused with "Missing required hook line." and stops the run.
- **Review P1 follow-ups still open.** The Higgsfield status path `/v1/requests/<id>/status` is derived from mocks and must be confirmed against provider documentation. Provider artifact host allowlisting and verification of the webhook edge rate limit/body cap remain open. The product-name rule judges the job's own copy; its rejection rate on real data still needs measurement.

## Not verified

- **OpenAI Decisions default model** `gpt-6-luna` is listed in OpenAI's official changelog, released 2026-09-22. Confirm it on the account before a production key is set. `OPENAI_DECISIONS_MODEL` overrides it.
- **Brand onboarding in a browser.** Sign-up, the 26 fields, reload resume and completion pass 19 browser checks. Not exercised: the viewer role, mobile width, dark mode and uploads.
