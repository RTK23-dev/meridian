# Meridian's chat connector (MCP)

A Claude chat (claude.ai, the desktop app or the phone app) or a ChatGPT chat can make Meridian videos. **The chat is the orchestrator:** it writes the
script, the plan and the coded video (a HyperFrames composition), and it can render the video in its own code sandbox, so none of that
costs the workspace anything. **Meridian does only what a chat cannot do:** a voiceover, an image and a decision from the workspace's
decision engine. It also stores the files. Each paid call draws on the brand budgets on the Billing page and reports its own cost.

## The workflow

Every video starts with a **quick Q&A** and is then made as a **project** through seven phases, each ending at a checkpoint.

**The Q&A (`meridian_start`).** Before making anything, the chat asks every question in one message: numbered questions, lettered
options, and the person's own words always welcome.
- the brand (asked only when there is more than one, with what each has left);
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
- no paid call is made past the video's own budget (`meridian_project_update` changes it). The brand budget still applies on top;
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
| Any paid call | A brand budget on the Billing page. A brand without one is refused and nothing is sent. |
| Voice, images | The OpenRouter key (Settings, Connections). |
| Images | A Studio image model (Settings, Models, Studio, Images). |
| Decisions | A decision engine that is ready (Settings, Connections, Decisions) and the decision cap on Billing. |
| Storing files | Google Drive connected (Settings, Connections). Without it, voice and images are refused before any call. |
| Download links | `MEDIA_LINK_SECRET` (at least 32 characters) in the deployment environment. Without it, files are stored but not linked. |
| Rendering in the chat | In claude.ai, allow this Meridian site in the code execution network settings, so the sandbox can download the files. |

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
| `meridian_voice_models` | free | The speech models the OpenRouter key can use, read live, with list prices. |
| `meridian_voiceover` | paid, $1 hold | Speaks the text with the chosen model and voice; stores the MP3. Settles at OpenRouter's bill. |
| `meridian_image` | paid, $1 hold | One image with the Studio image model; stores it. Settles at the reported cost, else at the hold. |
| `meridian_decide` | paid, decision cap | Choose between options, yes/no, or a 1 to 5 score from the active decision engine, with its probability. |
| `meridian_files` | free | The files made from chats, with fresh one-hour download links. |
| `meridian_render` | free | `claude`: the download links and the exact commands to render in the chat's sandbox. `hyperframes`: not available from the connector yet (see below). |

`meridian_voiceover`, `meridian_image` and `meridian_decide` take an optional `projectId`. With it, a paid call is linked to the video,
checked against its phase and budget, and counted in its spend.

How a paid call is guarded. This is the same lifecycle Studio and Factory media use.
1. A hold is reserved on the brand budget before the provider is called. With no budget, or not enough left, nothing is sent.
2. A call refused before sending (not connected, or a 4xx from the provider) releases its hold.
3. A call that may have reached the provider and then failed keeps its hold, and says so.
4. A call that succeeds settles at the cost the provider reported. If it reported none, it settles at the hold's ceiling
   (`unpriced-ceiling-v1`), so the budget never undercounts.

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
- **Saving a chat-rendered MP4 back to Meridian.** Not built: the hosted functions cap request bodies well below a video's size, so it
  needs a direct storage upload.
- **ChatGPT.** Its connector support is newer than Claude's, and the connector has not been tried from ChatGPT yet. It speaks the
  standard protocol, with JSON answers and no server stream.
- **Live runs.** No test calls a provider, so these still need a live run:
  1. One `meridian_voiceover`. The speech request is the video engine's (OpenRouter audio output), which is itself marked unverified live.
  2. One `meridian_image`.
  3. One `meridian_decide`.

  Record each one's cost, its file id and its audit row.
- **Function time.** An image can take up to 120 seconds. Confirm that the hosting's function time limit allows it (Vercel: the
  function's maximum duration).

Code:
- `src/lib/meridian/mcp/`: the protocol, the connectors, the tools, the workflow and its tools, the projects, the paid holds, the files
  and the HTTP handler;
- the routes `src/routes/api/mcp/` and `src/routes/api/mcp-files/`;
- migrations `0156_mcp_connector.sql` and `0157_mcp_projects.sql`;
- the Settings section `src/components/settings/claude-connector.tsx`.
