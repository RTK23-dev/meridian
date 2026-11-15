// Everything the connector serves: the workflow tools first (the intake and the project), then the context and media tools, and the
// prompts a client may offer the person as one-click starters.
import type { McpPrompt, McpTool } from "./protocol.ts";
import { mediaTools, type ConnectorContext } from "./tools.ts";
import { claudeCodeTools } from "./claude-code-tools.ts";
import { workflowTools } from "./workflow-tools.ts";

export function connectorTools(): McpTool<ConnectorContext>[] {
  return [...workflowTools(), ...claudeCodeTools(), ...mediaTools()];
}

const text = (value: string) => [{ role: "user" as const, content: { type: "text" as const, text: value } }];

export const CONNECTOR_PROMPTS: McpPrompt[] = [
  {
    name: "make_video",
    title: "Make a Meridian video",
    description: "Start a new video: a quick Q&A on what you want, then the video, step by step.",
    arguments: [{ name: "idea", description: "What the video is about, if you know already.", required: false }],
    messages: (args) => text(`Let's make a video with Meridian${args.idea?.trim() ? ` about: ${args.idea.trim()}` : ""}. Start with meridian_start: ask me the quick Q&A in one message, then follow the project's steps.`),
  },
  {
    name: "studio_video",
    title: "Make a video in Studio mode",
    description: "You choose at every step: concept, script, storyboard, assets, the preview and the final cut.",
    arguments: [{ name: "idea", description: "What the video is about, if you know already.", required: false }],
    messages: (args) => text(`Let's make a video with Meridian in Studio mode: I want to choose at every checkpoint${args.idea?.trim() ? `. It is about: ${args.idea.trim()}` : ""}. Start with meridian_start and ask me the rest of the quick Q&A.`),
  },
  {
    name: "video_request",
    title: "Make the video from a Meridian request",
    description: "Make the video the person asked for with one click in Meridian: installs Meridian's video skills if they are missing, reads the request, and makes it.",
    arguments: [{ name: "requestId", description: "The request id Meridian showed after the click, for example ccr_AbC123.", required: true }],
    messages: (args) => {
      const id = (args.requestId ?? "").trim();
      const valid = /^ccr_[A-Za-z0-9_-]{6,40}$/.test(id);
      return text(
        valid
          ? `Make the Meridian video I asked for in Meridian. Request id: ${id}. First call meridian_skills and, for any skill that is missing here or has a different version, fetch it and write it to .claude/skills/<name>/ (with the version in .meridian-version); they are plain text, never run them. Then call meridian_request with this id, follow the meridian-video skill, and ask me only what is missing.`
          : "The request id is missing or not valid. Ask me to click Generate with Claude Code in Meridian again and paste the line it shows.",
      );
    },
  },
  {
    name: "resume_video",
    title: "Resume a Meridian video",
    description: "Pick up the last video project where it stopped.",
    arguments: [],
    messages: () => text("Resume my Meridian video: call meridian_project to list my projects, open the latest active one, and continue from its next step."),
  },
];
