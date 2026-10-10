# Meridian glossary

The words the screens use, what each one means in the code, and where its wording lives. Screen wording comes from
`src/lib/copy.ts`. The popovers and badges are in `src/components/glossary.tsx`. Server codes such as `AUTO_APPROVE`,
`NOT_CONNECTED` and `test:image` are never changed on the server. The UI maps them to words, and the code stays under Details.

## Decisions

- **JEV** (shown as "Decision engine"): The decision engine. It reads the stored evidence for a question and returns a decision, a probability and a confidence. It recommends or routes work, and the configured approval steps still apply.
- **Decision**: The engine's result for a variant or opportunity. `AUTO_APPROVE` shows as "Approved", `HUMAN_REVIEW` as "Needs a person" and `REJECT` as "Rejected". No stored decision shows as "No decision yet", and any other code shows as "Unknown decision".
- **Probability**: The decision engine's estimate for its question, from 0% to 100%. It is not a measured result, and it is not calibrated against outcomes until a calibration report says so. It is shown as unknown, never as 0%, when no value is stored.
- **Confidence**: How strongly the stored evidence supports a decision. It is separate from probability, and it is not a guarantee of future ad performance.
- **Rank score**: The weighted score that orders opportunities. It adds the parts that help an idea and subtracts the parts that hurt it. It is not the decision probability.
- **Hypit** (shown as "Hypit video"): The video production engine. It runs as a separate process and renders from an approved brief. A clip is stored only after Hypit returns verified MP4 bytes.
- **JEV Research**: The upstream advertising intelligence layer that stores source-backed analysis and observed patterns. It informs JEV decisions but does not approve work itself.

## Ideas and evidence

- **Idea to test** (formerly "Exploration, not a finding" and "Prior"): A starting idea with no stored competitor observation or performance pattern behind it. Test it before relying on it, because it is not a finding.
- **Discovered**: An opportunity found in stored competitor rows, not taken from the list of starting ideas.
- **Supported**: A starting idea that stored competitor observations or learned performance patterns back.
- **Pattern**: A group of creatives the learning engine stored as performing differently from the brand baseline. It is stored only when the evidence is decisive: its chance of beating the baseline is at least 80% or at most 20%, and the false-discovery rate across tested patterns is 15% or less.
- **Lift**: How much better or worse a pattern performs than the brand baseline, shown as a percentage. +12% means 12% above the baseline rate.
- **Not enough results**: Shown where a number is missing or too small to read. It is never shown as zero.
- **Opportunity**: A ranked creative direction based on the evidence Meridian has stored for a brand.

## Publishing and providers

- **Publisher ID**: The ID a publisher returns for a publication, kept so the post can be found again. The test publisher records an ID and posts nothing.
- **Test image**: A fixture from the test runtime, labelled as a test and not a photograph.
- **Google Nano Banana**: The Google AI Studio image model. It uses the workspace production key.
- **Paused Meta publication**: A provider-confirmed Meta video, campaign, ad set, creative and ad chain created with delivery paused. It is not an active campaign.
- **Not connected** (`NOT_CONNECTED`): Meridian has no verified working connection for that provider. The feature does not substitute a test provider or report a live result.
- **Video engine not connected** (`HYPIT_NOT_CONNECTED`): Hypit is not set up, so no video is requested. Set it up in Integrations.
