# Roadmap

This is what is not built, or not verified, in this release. It is stated plainly so that nothing here looks finished.

## Not built

- **Live posting** to Facebook, Instagram and YouTube. The channels report not connected, and the manual export package is the way to deliver.
- **Google Drive connect from the app.** The Drive panel shows the real state and the setup steps. Connecting needs a Drive scope and a token
  store that the app does not have yet.
- **Live source calls.** The keyed connectors check that a key is present and say so; they do not yet call their APIs. Public web pages
  are read end to end.
- **Discovery runs in the interface.** Runs are recorded with per-source states, but no screen lists them yet, and discovery does not
  write evidence bundles (which would call the decision engine).
- **Video frame selection.** Choosing four relevant frames from the scene timeline is not built.
- **Calibration.** No calibration report exists yet, so every probability and score is uncalibrated and cannot approve or reject on its own.
- **A console field for Cyclone.** The Cyclone gateway is configured by the deployment's environment.

## Not verified

- The OpenAI Decisions default model name in code must be checked against the account before release. Set `OPENAI_DECISIONS_MODEL`
  explicitly until then.
- The brand onboarding resume and reload were not exercised in a browser in this release. The server logic is tested.
- Two concurrent discovery runs for one brand can store the same item twice. A unique index needs existing duplicates cleaned first.

## Known gaps

- A discovery run whose sources all fail reports `completed` in one test. The honest status is `blocked`.
- The Higgsfield status row still shows in the factory, and the server schema still accepts `higgsfield` and `auto` as video providers.
