# Roadmap

What is still open in this release. Each item says whether it is built and verified, built but unverified, or not built. Nothing here is listed as finished unless it is verified.

## Built, not verified against the live service

- **Live posting through connected accounts.** Facebook Page posts and YouTube Shorts uploads go out through a connected account. A receipt is stored only when the service returns an id. No request was made to either live API in this release.
- **Google Drive connect from the app.** Workspace admins connect with OAuth (`drive.file`) from Settings, and can disconnect from the same panel. Not exercised against a live Google account.
- **Live source calls.** YouTube, SerpAPI and Meta Ad Library have request code and tests against fixtures of their documented response shapes. No live key was used.
- **Discovery runs in the interface.** The Market screen starts a run and lists recent runs with each source's state.
- **Calibration report.** It says "not calibrated" until 200 usable outcomes exist, and shows no numbers before then.
- **Video frame selection.** `video/scene-frames.ts` picks the highest-relevance scene per quarter from the scored timeline. The production image checks do not use it yet.

## Open

- **Instagram Reels posting.** Reports not connected. It needs a public https route for stored media and a token with `instagram_content_publish`.
- **Facebook Page token.** Meta sign-in requests only ads scopes, so the Page token has to be pasted.
- **YouTube upload visibility.** Uploads default to public. Confirm that default before release.
- **Drive folder visibility.** Under `drive.file`, a workspace connected by OAuth sees only folders the app created. A `MERIDIAN_DRIVE_FOLDER_ID` created elsewhere will refuse uploads from that token. Decide whether the app creates the folder at connect time.
- **Drive export packages.** No code writes export packages to Drive, so no export row exists for them.
- **Canonical-URL dedupe.** Not indexed. Link-less cards share their page's URL, so a unique index would refuse distinct records. Page evidence is keyed by content hash only. Brand-scoped content-hash indexes are in migration 0059.
- **JEV request timeout.** The TypeSafe transport has no request timeout, so a hung call is unbounded.
- **Calibration threshold.** `calibration/propose.ts` needs 30 rows, while the report uses 200. Pick one.
- **Fixed defaults in scoring.** `opportunity/engine.ts` uses fixed reproducibility values (0.9, 0.62, 0.35), `grading/engine.ts` defaults a missing score to 0.5, `calibration/report.ts` returns 0 for a missing score, and `jev/policy.ts` fallback thresholds differ from its defaults. Scoring is out of scope for this release, so these are listed rather than changed.
- **Environment reads outside the contract.** `GOOGLE_ADS_DEVELOPER_TOKEN` has no entry in `credentials/contract.ts`. Other reads sit outside it in `discovery/cyclone-scout-adapter.ts`, `settings/provider-config.ts`, `notifications/email.ts`, `factory/sources.ts`, `embeddings/external.ts`, `system.ts`, `routes/api/webhooks/receive.ts` and `storage/google-auth.ts`.
- **Cyclone console field.** The Cyclone gateway is configured by the deployment's environment only.
- **Lint warnings.** Six `react-refresh/only-export-components` warnings remain in existing files. They are not errors.

## Not verified

- **OpenAI Decisions default model** `gpt-6-luna` is listed in OpenAI's official changelog, released 2026-09-22. Confirm it on the account before a production key is set. `OPENAI_DECISIONS_MODEL` overrides it.
- **Brand onboarding in a browser.** Sign-up, the 26 fields, reload resume and completion pass 19 browser checks. Not exercised: the viewer role, mobile width, dark mode and uploads.
