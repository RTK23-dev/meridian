# Product

Meridian is a multi-tenant advertising operating system. A customer creates a workspace, adds a brand, and builds a Brand Brain the rest of the system has to use.

This repository is original software under the MIT License. It is not a fork of Hypit or of any decision-engine product. Structured creative workflows were a design reference only. None of that source is included.

## What this version does

- Sign-in with email and password, or with Google or X.
- Workspaces with roles. Checks run on the server.
- Brands, Brand Brain, provenance, versions, and products.
- Manual competitor observations and a guarded public-page fetch. No ad library.
- Opportunity scoring from that evidence, with JEV gates.
- Briefs that carry learned patterns and past rejections.
- Human-written scripts, plus text generation when a provider key is configured.
- Text guardian and review queue. Images, if generated, are not visually approved.
- Manual performance, learned patterns, and the next rank using those patterns.
- An audit log and a decision log.

## What this version does not do

- Scrape an ad library or invent competitor ads.
- Read performance from an ad account.
- Run a vision model.
- Publish.
- Treat an empty market as if it had been measured.

Empty states say so.
