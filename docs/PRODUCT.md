# Product

Meridian is a multi-tenant advertising operating system. A customer creates a workspace, adds their own brands, and builds a Brand Brain the rest of the system is required to use.

This repository is original software under the MIT License. It is not a fork of Hypit, JEV, or any other product. Structured creative workflows were a design reference only. Hypit’s license does not allow relicensing its source to MIT or using that source to run a multi-tenant service, so none of that source is included.

## What this version actually does

- Sign-in with email and password, or with Google or X.
- Workspaces with roles: owner, admin, member, viewer. Checks run on the server.
- Brands the customer creates. There is no built-in brand.
- Editable brand identity, Brand Brain, provenance, and saved versions.
- Products, including allowed and prohibited claims.
- Recorded invites when the email does not match an existing account. Email is not sent.
- Configurable opportunity weights and a deterministic scoring function. Nothing is scored until evidence exists.
- An audit log for workspace, brand, brain, product, member, and scoring changes.

## What this version does not do

These are unavailable, not simulated:

- Website or document ingestion.
- Competitor discovery or ad collection.
- Model calls, image generation, video generation, vision QA.
- Performance import and learning write-back.
- Publishing.

Empty states say so.
