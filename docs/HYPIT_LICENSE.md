# Hypit: licence position and status in Meridian

Checked 2026-10-24 against the public repository `hypit-ai/hypit` (shallow clone, commit `e26d914`, file `LICENSE`). This is a
reading of the licence text, not legal advice. Any multi-tenant or commercial use needs Hypit.AI's written authorization.

## What the licence allows

Hypit is Apache 2.0 with added conditions. Without a commercial licence you may:
- run Hypit yourself on your own infrastructure;
- use it for your own organization's work, including commercial work and work for your clients;
- run a single-tenant deployment operated by and for one organization, including as the generation backend for an application that
  organization operates for itself.

## What needs written authorization from Hypit.AI

- **Multi-tenant or hosted service (clause 1a).** Operating an environment in which two or more parties outside your organization hold
  separate workspaces is multi-tenant, with or without a fee. Offering Hypit's functions to third parties as a hosted, managed or
  software-as-a-service product is the same. One workspace is one tenant.
- **Commercial redistribution (clause 1b).** Selling, licensing for a fee, or supplying Hypit or a derivative for commercial gain,
  alone or bundled into a product or package given to third parties.
- **Branding (clause 1c).** Do not remove or change Hypit's name, logo or copyright in the CLI, its run reports and manifests, or any
  user-facing surface derived from them.

## What this means for Meridian

- Meridian is multi-workspace: each organization is a workspace, and its data is keyed by `organizationId`. A Meridian deployment
  that serves more than one organization outside the operator is multi-tenant under clause 1a. Hosted Meridian therefore needs written
  authorization before any Hypit call.
- The single-organization bridge (`scripts/hypit-bridge.mjs`) fits the permitted case only when one organization runs both the bridge
  and the CLI for its own work.
- Meridian does not remove or change Hypit branding: neither the bridge nor the handoff (`src/lib/meridian/hypit/`) strips a logo or
  copyright string. Keep it that way.

## Status in Meridian

- **Not connected.** The production router's `hypit` route refuses every job with `NOT_CONNECTED`
  (`src/lib/meridian/production/providers/hypit.ts`). Its per-second price is unknown, so the cost matrix never selects it.
- The handoff (`src/lib/meridian/hypit/handoff.ts`) records a job as not connected when no token is saved.
- The bridge is a single-organization proof runner. It keeps jobs in memory and has no multi-tenant runtime, no verified cost and no
  recorded live run. It is not a verified production runtime.
- The Hypit CLI is not in this repository or the Meridian image.

## Options

1. **Self-hosted, one organization (permitted).** One organization runs the Hypit CLI and the bridge on its own infrastructure, for its
   own work. Still needed: the owner's confirmation that the deployment is single-organization, and one live run with the real CLI
   that records the job id, the artifact and any cost. No live run has been made.
2. **Hosted, multi-workspace Meridian (blocked).** Needs Hypit.AI's written authorization or a commercial licence first. Nothing is to be
   built for this until that reply is in writing.
3. **Without Hypit.** The product already routes video through Gemini Omni and Higgsfield (each under its own terms, each needing its
   own connected key), and the cloud render path uses HyperFrames (its price is unverified; see `src/engine/render/STATUS.md`).

Recommendation: keep Hypit out of production routing. Ask Hypit.AI in writing if hosted use is wanted. Do not build a multi-tenant
integration until the answer is in writing.

## Owner decisions

1. Is the intended deployment one organization (option 1), or a multi-workspace service (option 2)?
2. For option 2: will you ask Hypit.AI for written authorization or a commercial licence? No contact has been made.
