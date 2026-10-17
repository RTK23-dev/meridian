# Meridian

Meridian is the operating system for one brand's advertising. You give it the brand. It gathers evidence, decides what is worth making, produces the ads, and changes the next recommendation after it sees what happened.

It does not invent a result. A step with no key, no account, or no bill says so and stores nothing.

## The loop

1. **Brand.** Positioning, customers, tone, claims, and products.
2. **Evidence.** Pages, ads, and uploads the brand is allowed to use.
3. **Decision.** JEV answers a fixed set of questions from that evidence.
4. **Brief.** An approved decision becomes a creative brief.
5. **Make.** Images go to the configured image provider. Video can go to Gemini Omni, Hypit, Higgsfield, or a manual cloud folder. Hypit is a separate process.
6. **Check.** Claims, brand rules, and a review.
7. **Publish.** Organic posts go to a connected account. Paid ads are created paused. Meridian does not turn them on.
8. **Learn.** Measured results are stored. A grade already stored is not rewritten when calibration changes.

## Pages

- [Setup](Setup.md)
- [Product loop](Product-loop.md)
- [Credentials](Credentials.md)

This release is `0.1.0-beta.13`. Tests cover the loop with fixtures. A live provider run is recorded only after the keys are on the server.
