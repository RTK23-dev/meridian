# Product

Meridian is a multi-tenant advertising operating system. A customer creates a workspace, adds a brand, and builds a Brand Brain the rest of the system has to use.

This repository is original software under the MIT License. It is not a fork of Hypit or of any decision-engine product. Structured creative workflows were a design reference only. None of that source is included.

## What this version does

- Sign-in with email and password, or with Google or X.
- Workspaces with roles. Checks run on the server.
- Brands, Brand Brain, provenance, versions, and products.
- Manual competitor observations, candidate discovery from stored names, and a guarded public-page fetch.
- JEV Research can collect bounded Meta Ad Library video records, store verified public source MP4s and timestamped transcripts, and save confidence-rated transcript analysis with provenance. Missing media remains unavailable; transcript-only analysis does not make visual claims.
- Observed cross-ad patterns can inform existing opportunities. Pattern summaries report frequency rather than advertising effectiveness; organization summaries are aggregate-only and require the existing brand opt-in.
- Opportunity scoring from that evidence, with JEV gates.
- Briefs that carry learned patterns and past rejections.
- Approved briefs can be handed to the separate Hypit video process.
- Human-written scripts, plus text generation when a provider key is configured.
- Text guardian, PNG logo comparison, and a review queue.
- Manual performance, and a normalizer that a live feed must pass before learning.
- A worker process and a scheduler process when `DATABASE_URL` is set on a long-lived host.
- Provider clients that can probe and create paused campaigns when credentials exist and a request succeeds.

## What this version does not do

- Invent competitor ads, metrics, or publish receipts.
- Treat credentials as a connection before a provider request succeeds.
- Bundle a video-generation runtime; Studio video uses the separately configured Hypit process.
- Keep the worker alive on a serverless host.
- Claim WCAG certification. The accessibility notes are in [ACCESSIBILITY.md](ACCESSIBILITY.md).

Empty states say so. Connection states are on the Integrations screen.

