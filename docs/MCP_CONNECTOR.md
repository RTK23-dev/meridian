# Meridian's Claude connector (MCP)

A Claude chat (claude.ai, the desktop app or the phone app) can make Meridian videos. **The chat is the orchestrator:** it writes the
script, the plan and the coded video (a HyperFrames composition), and it can render the video in its own code sandbox, so none of that
costs the workspace anything. **Meridian does only what a chat cannot do:** a voiceover, an image and a decision from the workspace's
decision engine. It also stores the files. Each paid call draws on the brand budgets on the Billing page and reports its own cost.

## Set it up (once)

1. **Meridian, Settings, Connections, Claude connector.** An admin names a link and presses *Make a link*. Copy the link: it is shown
   once.
2. **claude.ai, Settings, Connectors, Add custom connector.** Paste the link as the server URL and leave OAuth empty.
3. **In a chat,** turn the connector on and ask for a video. Claude starts with `meridian_status` and `meridian_video_guide`.

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
| `meridian_status` | free | Brands with budget, committed and left; the monthly budget and decision cap; which paid services are ready. |
| `meridian_brand` | free | The brand brain in the brand's own words (tone, claims, words to avoid, colours, imagery rules). |
| `meridian_video_guide` | free | The steps, the HyperFrames format (1080 × 1920, 30 fps, GSAP timeline) and the render options. |
| `meridian_voice_models` | free | The speech models the OpenRouter key can use, read live, with list prices. |
| `meridian_voiceover` | paid, $1 hold | Speaks the text with the chosen model and voice; stores the MP3. Settles at OpenRouter's bill. |
| `meridian_image` | paid, $1 hold | One image with the Studio image model; stores it. Settles at the reported cost, else at the hold. |
| `meridian_decide` | paid, decision cap | Choose between options, yes/no, or a 1 to 5 score from the active decision engine, with its probability. |
| `meridian_files` | free | The files made from chats, with fresh one-hour download links. |
| `meridian_render` | free | `claude`: the download links and the exact commands to render in the chat's sandbox. `hyperframes`: not available from the connector yet (see below). |

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
- **Live runs.** No test calls a provider, so these still need a live run:
  1. One `meridian_voiceover`. The speech request is the video engine's (OpenRouter audio output), which is itself marked unverified live.
  2. One `meridian_image`.
  3. One `meridian_decide`.

  Record each one's cost, its file id and its audit row.
- **Function time.** An image can take up to 120 seconds. Confirm that the hosting's function time limit allows it (Vercel: the
  function's maximum duration).

Code: `src/lib/meridian/mcp/` (protocol, connectors, tools, paid holds, files, the HTTP handler), the routes `src/routes/api/mcp/`
and `src/routes/api/mcp-files/`, migration `0156_mcp_connector.sql`, and the Settings section
`src/components/settings/claude-connector.tsx`.
