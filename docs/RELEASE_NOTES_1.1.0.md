# Meridian 1.1.0

Released 2026-11-18 as stable, by the owner's decision, **before any live provider run**. Every feature below is tested with fixtures,
fake services, a seeded local app, a stand-in for the Claude Code CLI and PostgreSQL in CI. The live checks still owed are listed at the
end and in docs/RELEASE_CHECKLIST.md.

## What is new since 1.1.0-beta.1

**Making a video**
- Create is the one front door: free with Claude Code on your own computer, with Meridian using your keys, or many variations in Batch.
- The Claude Code runner (`npm run claude:runner`) turns a click into a video with no pasting: a queue with leases and heartbeats, a
  fresh conversation per video that is not saved to your Claude Code history, the model you choose (Auto, Best quality, Fastest), live
  progress in the card, several computers, start with the computer (`--install`), an optional sandbox (`--sandbox`), and "done" only when
  a video was really saved.
- Gemini Decisions joins OpenRouter Decisions as an engine that can answer; Setup offers only engines that can answer in this version.

**Accounts and people**
- Password reset by email ("Forgot your password?"), with one-time links that expire in an hour.
- Invitations work with or without email: without it, the admin gets the link to pass on.

**Sending things out, safely**
- Facebook Page posting, alert webhooks and Google Drive writes are switched on, each with a guard so a retry or a double click cannot
  act twice; an unknown outcome is held as "uncertain" until a person checks.
- Instagram, YouTube and TikTok posting, paused ads and the Meta ad-account upload stay off and say so on screen.

**Running it**
- `npm run db:backup`, `db:restore` and a restore drill (`db:restore-drill`, weekly in CI); `GET /api/ready` for uptime monitors;
  `npm run load-check`; `npm run keys:rotate` to change `TOKEN_ENCRYPTION_KEY` without losing saved keys; docs/RUNBOOK.md.

**Simpler**
- A new workspace sees one step; advanced screens are hidden until you turn them on; plain words instead of JEV, cookbook and other
  internal names on the main screens.

## Upgrading

Run the migrations (0159 to 0166). New optional settings are in `.env.example`. Email needs `EMAIL_API_URL` and its key. See
CHANGELOG.md, "1.1.0".

## Not verified live yet

The runner with the real Claude Code CLI; a Create run with an OpenRouter key; an invitation and a password-reset email; a Facebook Page
post; a voiceover's billed cost against its hold; an alert webhook; a Google Drive write; a restore drill on the deployment's database.
Calibration on real outcomes has not started (200 are needed).
