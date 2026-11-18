# Meridian's chat connector (MCP)

A Claude chat (claude.ai, the desktop app or the phone app) or a ChatGPT chat can make Meridian videos. **The chat is the orchestrator:** it writes the
script, the plan and the coded video (a HyperFrames composition), and it can render the video in its own code sandbox, so none of that
costs the workspace anything. **Meridian does only what a chat cannot do:** a voiceover, an image and a decision from the workspace's
decision engine. It also stores the files. Each paid call reports its own cost and draws on a budget on the Billing page: the brand's
budget, or, for a video made without a brand, the workspace's monthly budget.

**A video does not need a brand** (owner direction 2026-11-09). Without one, the video is the workspace's own: its files are kept in
the workspace's own space and its paid calls come from the monthly budget. Google Drive is not needed either: until it is connected,
Meridian keeps the files in its own database.

## The workflow

Every video starts with a **quick Q&A** and is then made as a **project** through seven phases, each ending at a checkpoint.

**The Q&A (`meridian_start`).** Before making anything, the chat asks every question in one message: numbered questions, lettered
options, and the person's own words always welcome.
- the brand, with what each has left, or "No brand" (the workspace's own video, paid from the monthly budget). A workspace with no
  brand is not asked;
- what the video should do;
- what it is about;
- where it runs and how long;
- the style: Meridian's cookbooks that a chat can make (for example *Voice-led list*, *UGC product*, *3D data explainer*), kinetic type,
  or the person's own;
- the voice;
- **how involved the person wants to be**;
- who renders;
- the most Meridian may spend on this video.

The answers create the project (`meridian_project_create`), which returns the plan and the first step.

**The modes.** Who settles each checkpoint:

| Phase | Studio | Guided | Orchestrator |
| --- | --- | --- | --- |
| Concept: the hook and the angle | person | chat | chat |
| Script: the words, timed to the length | person | **person** | chat |
| Storyboard: each scene, its text and its line | person | chat | chat |
| Asset plan: what to make and what it holds | person | chat | chat |
| Build: the coded video, previewed | person | chat | chat |
| Render: the MP4 | chat | chat | chat |
| Deliver: the final cut | person | **person** | chat |

**A person's checkpoint.** It works the same way every time:
1. The chat writes two to five options and records them (`meridian_checkpoint` *propose*).
2. It shows them as A, B, C, "or tell me your own", and waits.
3. It settles the checkpoint with the person's choice, or their own words, and the settled text (*resolve*, `decidedBy: "person"`).

**The chat's checkpoint.** The chat settles it itself and says in one line what it chose. Where a choice matters it asks
`meridian_decide`, Meridian's decision engine, rather than judging its own work.

**What Meridian enforces.** Claude and ChatGPT cannot drift from the workflow, because Meridian checks:
- the phases go in order;
- a person's checkpoint needs its options shown first, and a choice that is one of them, or the person's own words;
- the concept, the script, the storyboard and the asset plan are kept as text, so each phase builds on the last;
- going back is a *reopen*, which clears that phase and every later one;
- nothing is paid for (voice, images) before the asset plan is settled;
- no paid call is made past the video's own budget (`meridian_project_update` changes it). The brand's budget, or the monthly budget
  for a video without a brand, still applies on top;
- a delivered or abandoned video takes no more steps.

Every tool answer ends with the exact next step, so a chat can resume a video at any time (`meridian_project`).

**One-click starters.** The connector also offers MCP prompts that a client can show in its menu: *Make a Meridian video*, *Make a
video in Studio mode* and *Resume a Meridian video*.

## Set it up (once)

1. **Meridian, Settings, Connections, Chat connector.** An admin names a link and presses *Make a link*. Copy the link: it is shown once.
2. **Add it to the chat:**
   - **Claude:** claude.ai, Settings, Connectors, Add custom connector. Paste the link as the server URL and leave OAuth empty.
   - **ChatGPT:** turn on developer mode for connectors, then add a connector with the link and no authentication.
3. **In a chat,** turn the connector on and ask for a video, or pick *Make a Meridian video*. The chat starts with the Q&A.

What the workspace needs before paid calls work:

| Needed for | Where |
| --- | --- |
| Any paid call | On the Billing page: the brand's budget for a brand's video, or the monthly budget for a video without a brand. A call whose budget is not set, or too low, is refused and nothing is sent. |
| Voice, images | The OpenRouter key (Settings, Connections). |
| Images | A Studio image model (Settings, Models, Studio, Images). |
| Decisions | A decision engine that is ready (Settings, Connections, Decisions) and the decision cap on Billing. |
| Storing files | Nothing. Files are kept in Meridian's own database (up to 50 MB each), or in Google Drive when Drive is connected. |
| Download links | `MEDIA_LINK_SECRET` (at least 32 characters) in the deployment environment. Without it, files are stored but not linked. |
| Rendering in the chat | In claude.ai, allow this Meridian site in the code execution network settings, so the sandbox can download the files. |

## Claude Code

Claude Code can use the same connector and make the video on your own computer, free. Add it once with the command Meridian shows beside the
link (`claude mcp add --transport http meridian <link>`), work from a checkout of this repository, and ask for a Meridian video. The
`meridian-video` skill (`.claude/skills/meridian-video/SKILL.md`) walks Claude Code through the Q&A, the checkpoints, the free coded styles and
the render, then saves the MP4 back with `meridian_upload_link`. It needs Node 22, Chromium and ffmpeg locally. Nothing is verified live.

## The tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `meridian_start` | free | The Q&A to ask first, with options for each question. |
| `meridian_project_create` | free | The project from the answers: the plan in the chosen mode, and the first step. |
| `meridian_project` | free | One project's phases, who settled each, its spend against its budget, its files and its next step; without an id, the recent projects. |
| `meridian_checkpoint` | free | *propose* the options shown, *resolve* a phase, or *reopen* one; Meridian enforces the order and who decides. |
| `meridian_project_update` | free | Change the mode or the video's budget, or abandon the project. |
| `meridian_status` | free | Brands with budget, committed and left; the monthly budget and decision cap; which paid services are ready. |
| `meridian_brand` | free | The brand brain in the brand's own words (tone, claims, words to avoid, colours, imagery rules). |
| `meridian_video_guide` | free | The steps, the HyperFrames format (1080 × 1920, 30 fps, GSAP timeline) and the render options. |
| `meridian_voice_models` | free | OpenRouter's text-to-speech models, read live (`/models?output_modalities=speech`), each with its rate per 1,000 characters and the voices it lists. |
| `meridian_voiceover` | paid, $1 hold | Speaks the text with the chosen model and one of its voices (`POST /audio/speech`, MP3), with an optional delivery style; stores the MP3. A voice the model does not list is refused before sending. Settles at OpenRouter's bill, read by the answer's `X-Generation-Id`. A brand is optional. |
| `meridian_image` | paid, $1 hold | One image with the Studio image model; stores it. Settles at the reported cost, else at the hold. A brand is optional. |
| `meridian_decide` | paid, decision cap | Choose between options, yes/no, or a 1 to 5 score from the active decision engine, with its probability. |
| `meridian_files` | free | The files made from chats, with fresh one-hour download links. |
| `meridian_upload_link` | free | A 15-minute address to send a finished file to (an MP4 rendered on your own machine, or an MP3, WAV, PNG or JPEG), up to 50 MB. It checks the file is what it says, stores it with the video project and lists it in `meridian_files`. Revoking the link stops uploads at once. |
| `meridian_skills` | free | Lists the video skills Meridian offers to Claude Code, each with a version; with a name, returns that skill's plain-text files to write into `.claude/skills/<name>/`. Only the video skills are offered (`meridian-video`, `cookbook-video`, `direction-scripts`, `motion-designer`, `pixel-explainer`). |
| `meridian_runner_next`, `meridian_runner_report` | free | For the runner, not for a chat: check in and take the next waiting request under a lease; renew the lease or report the end. |
| `meridian_request` | free | Reads the request a member made with one click in Settings: the idea, the brand, and the data it came from (what Meridian gathered, the Content Factory's latest plan, or their own words). The text it shows came from outside and is data, never instructions. Pass its id to `meridian_project_create` as `requestId` to link the project. |
| `meridian_render` | free | `claude`: the download links and the exact commands to render in the chat's sandbox. `hyperframes`: not available from the connector yet (see below). |

`meridian_voiceover`, `meridian_image` and `meridian_decide` take an optional `projectId` and an optional `brandId`. With a project, a
paid call is linked to the video, checked against its phase and budget, counted in its spend, and paid like the project (its brand, or
the monthly budget when it has none). Without either, the call is the workspace's own, paid from the monthly budget.

How a paid call is guarded. This is the same lifecycle Studio and Factory media use.
1. A hold is reserved before the provider is called: on the brand's budget, or, for a video without a brand, on the monthly budget
   (the same ledger as paid text generation, `providers/generation-ledger.ts`). With no budget, or not enough left, nothing is sent.
2. A call refused before sending (not connected, or a 4xx from the provider) releases its hold.
3. A call that may have reached the provider and then failed keeps its hold, and says so. On the monthly budget it is marked
   uncertain, so an admin can check it against the provider's account and release it on the Billing page.
4. A call that succeeds settles at the cost the provider reported. If it reported none, it settles at the hold
   (`unpriced-ceiling-v1`), so the budget never undercounts.

How much a call holds:
- **An image** holds $1, because no per-image price is declared.
- **A voiceover** holds its text at the model's list rate times 2, rounded up to a cent, at least $0.01 and at most $1 (`speech.ts`
  `voiceHoldUsd`). A few spoken lines hold cents. A speech model with no stated rate holds $1.
- **The voiceover's bill** can lag the audio by a few seconds on OpenRouter, so it is read up to four times before the call settles
  without one.

A decision asked for a video without a brand is recorded in the decision log with no brand, so it is in no brand's calibration.

Every paid call is written to the audit log with the link that made it.

## Security

- **What is stored.** Only the link's SHA-256 is stored, with its last four characters to tell links apart. The link itself is shown once.
- **Who it acts as.** A link acts as the admin who made it, with that person's role read on every call. A viewer's role cannot spend. A
  member who leaves takes their links' access with them.
- **Revoking.** Revoke a link in Settings, and it answers nothing from then on. An unknown, revoked or orphaned link gets the same 401.
- **Limits per call.** Calls are limited to 60 a minute per link (held in each server instance), and bodies to 1 MB.
- **File links.** Each one is signed (HMAC with its own label) and lasts an hour.
- **Treat the link like a password.** It is in the URL because claude.ai's custom connectors take a URL. Clients that can send headers can
  use `POST /api/mcp/` with `Authorization: Bearer <secret>` instead.

## Not built yet, and the owner's live steps

- **Cloud render (`renderer: "hyperframes"`).** It runs inside the video engine's jobs (HyperFrames cloud, then Shotstack). A chat cannot
  start those, so the tool says so. Rendering in the chat is free and works today.
- **Saving a chat-rendered MP4 back to Meridian from a chat sandbox.** A coding agent on its own machine (Claude Code) saves it with
  `meridian_upload_link`. A chat's sandbox can do the same if it can reach this Meridian site; the hosted functions cap request bodies well
  below a video's size, so on a hosted deployment a large file still needs a direct storage upload.
- **ChatGPT.** Its connector support is newer than Claude's, and the connector has not been tried from ChatGPT yet. It speaks the
  standard protocol, with JSON answers and no server stream.
- **Live runs.** No test calls a provider, so these still need a live run:
  1. One `meridian_voiceover` (OpenRouter's TTS endpoint, `POST /audio/speech`).
  2. One `meridian_image`.
  3. One `meridian_decide`.

  Record each one's cost, its file id and its audit row.
- **Function time.** An image can take up to 120 seconds. Confirm that the hosting's function time limit allows it (Vercel: the
  function's maximum duration).

Code:
- `src/lib/meridian/mcp/`: the protocol, the connectors, the tools, the workflow and its tools, the projects, the paid holds, the files
  and the HTTP handler;
- the routes `src/routes/api/mcp/` and `src/routes/api/mcp-files/`;
- migrations `0156_mcp_connector.sql`, `0157_mcp_projects.sql` and `0158_videos_without_a_brand.sql`;
- the store every video file goes through: `src/lib/meridian/storage/meridian-store.ts` (Drive when connected, else
  `database-store.ts`);
- the Settings section `src/components/settings/claude-connector.tsx`.

## One click from Create, to Claude Code

Create, **Free, with Claude Code on your computer** (`/create?way=claude_code`; Settings, Connections points there): pick a brand, pick where the idea comes from, and click **Generate with Claude Code**.

- **Data Meridian already gathered**: the brand's best open opportunity (ranked by expected value) and the research patterns behind it.
- **The Content Factory's latest plan**: the objective and brief of the brand's newest live plan.
- **My own idea**: your words.

A source with nothing behind it is greyed out with what to do first; nothing is filled in. The click records a request (24 hours, migration
0160) and copies one line, `/mcp__meridian__video_request <id>`, to paste into Claude Code (the connector's own prompt, so only the connector is needed: it installs the skills when they are missing). The `meridian-video` skill reads the request through
`meridian_request`, asks only what is missing, makes the video on your own computer, and saves the MP4 back. Nothing starts until the line is
pasted. A video made inside Meridian, with the engine and its review gates, is the regular Content Factory, linked from the same card.

## The runner: how a request becomes a video

**Setup is one step, once.** The card's **Connect this computer** button (an admin) gives one command, `npm run claude:runner -- <link>`. Run it
in the Meridian folder on the computer that has Claude Code, and leave it running; after the first time `npm run claude:runner` is enough (the
link is kept in `.meridian/runner.json`, readable only by you, and git ignores it).

**What happens on a click.** A request is a job in a queue (migrations 0160, 0163 and 0166).

1. The runner asks Meridian for the next job every few seconds (`meridian_runner_next`). Two runners never get the same job.
2. It starts **a fresh Claude Code conversation for that job** (`claude -p`). A retry starts fresh too. Nothing carries over from an earlier
   video or from whatever else you use Claude Code for. **The conversation is not saved** (`--no-session-persistence`), so making a hundred
   videos adds nothing to your Claude Code history. The record of a job is its log in `.meridian/runner-logs/` (the newest 50 are kept).
   To look into one job as a conversation, start the runner with `-- --keep-sessions`.
3. **The model is the one chosen in the card:** Auto (Claude Code's `sonnet`), Best quality (`opus`) or Fastest (`haiku`). These are Claude
   Code's own names, so each follows Claude Code's current model for that tier.
4. The session may use only Meridian's tools, the file tools, skills, and four programs (`node`, `ffmpeg`, `ffprobe`, `curl`). Anything else is
   denied, not asked, because nobody is watching. Claude Code's command rules narrow what it does; they are not a sandbox.
5. It uses **your own Claude Code sign-in.** An `ANTHROPIC_API_KEY` in the environment is left out, so nothing is billed to a key, and the
   job is told to spend nothing in Meridian (`budgetUsd` 0, no paid tool).
6. The runner reads Claude Code's events as they come (`--output-format stream-json --verbose`) and turns each into a short label: reading
   the request, planning, following a skill, rendering, saving the video. The latest label goes to Meridian with the heartbeat (and at
   once when it changes, at most every 10 seconds), and the card shows it: "Being made: Rendering". A label names the step only; the link,
   commands and a tool's arguments never go into it (a skill's name does, when it is a plain name). At the end the runner reports how many
   turns Claude Code took and how long it ran, when Claude Code said so, and the card shows them under the finished request.
7. The runner sends a heartbeat every 30 seconds. If it stops (the computer sleeps, the terminal closes), the job is queued again after three
   minutes, up to three tries, then marked failed with the reason. A job is stopped after 45 minutes.
8. **Done is checked, not believed.** Claude Code must exit cleanly and end with its final result event, without an error flag; a run
   that stops without that result is a failure. Then Meridian looks for a saved video on the request's project. If there is
   none, the request is marked failed and says why. A scripts-only request needs only its project.

The card shows the runner (ready, connected but not ready with what is missing, or not running) and each request's state (waiting, being
made, done, failed with its reason), with **Run again** and **Cancel**. Cancelling a job that is being made stops it on the runner at the
next heartbeat. With no runner running, a request waits 24 hours, and its line can still be pasted into Claude Code by hand.

Before each job the runner checks this computer: Node 22, Claude Code installed and signed in, `ffmpeg` and `ffprobe`. A failed check is
shown in the card in plain words, and no job is taken until it passes.

**Start with the computer.** `npm run claude:runner -- --install` (after the link is saved) writes a per-user service, so the runner starts
when you sign in and starts again if it stops:

| System | File | Turn it on |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.meridian.claude-runner.plist` | `launchctl load -w <that file>` |
| Linux | `~/.config/systemd/user/meridian-claude-runner.service` | `systemctl --user daemon-reload` then `systemctl --user enable --now meridian-claude-runner.service` |
| Windows | `meridian-claude-runner.cmd` in your Startup folder | starts at your next sign-in (or open the file) |

The command prints exactly what to run and runs it for you only with `--install --now`. The file holds the full path of Node.js, the
Meridian folder and your PATH, never the link: the runner reads that from `.meridian/runner.json` (a custom `MERIDIAN_RUNNER_HOME` is not
carried into the service). `--sandbox` and `--keep-sessions` given with `--install` are kept. It restarts after 10 seconds when it stops,
except when the link is missing or refused (exit code 2), which a restart cannot fix; macOS restarts it at most once a minute. Its output
goes to `.meridian/runner-service.log`. On Linux a user service runs while you are signed in; `loginctl enable-linger "$USER"` keeps it
running when you are not. `npm run claude:runner -- --uninstall` stops it and removes the file.

**Several computers.** Run the runner on as many computers as you like in one workspace, each with its own name
(`MERIDIAN_RUNNER_NAME`, or the computer's name). A job goes to whichever asks first; the database hands each job to exactly one
(`for update skip locked`, tested with two runners asking at the same moment). The card lists every computer online: "Ready on laptop,
desktop", and any that are connected but not ready, with what is missing on each.

**Containment (`--sandbox`).** Claude Code's command rules match command text; they are not a sandbox. With
`npm run claude:runner -- --sandbox`, each job's Claude Code runs inside the system's own sandbox:

- Linux: bubblewrap (`bwrap`). The whole system is read-only, `/tmp` is private to the job, the Meridian folder and Claude Code's own
  settings (`~/.claude`, `~/.claude.json`, where it keeps its sign-in) are writable, and the sandbox ends with the runner.
- macOS: `sandbox-exec`, with a profile that denies writing anywhere but the Meridian folder, the temporary folders and Claude Code's
  settings.

**It limits files, not the network.** Claude Code must reach Anthropic and Meridian, so the network stays open inside the sandbox, and a
job can still read what your user can read. If `--sandbox` is asked for and the sandbox program is not there (or on Windows), the runner
says so and does not start: it never runs unsandboxed instead.

**Stopping a job.** A cancelled, timed-out or interrupted job is stopped as a whole: Claude Code runs in its own process group, which gets
SIGTERM and, ten seconds later, SIGKILL (on Windows, `taskkill /T`). Programs it started (node, ffmpeg) stop with it.

**Not verified.** The queue, the runner's rules and the whole loop are tested with a stand-in for Claude Code. No run with the real Claude
Code CLI is recorded: the flags are the documented ones (`-p`, `--model`, `--no-session-persistence`, `--output-format stream-json`,
`--verbose`, `--permission-mode dontAsk`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`), the event shapes the progress labels read
(`system`/`init`, `assistant` messages with `tool_use` parts, the final `result` with `num_turns` and `duration_ms`) are taken from Claude
Code's documentation, and the first real run is the owner's to make. The service files are checked by their contents in tests; none has
been loaded by launchd, systemd or Windows here. The sandbox-exec profile is untested on a Mac.
