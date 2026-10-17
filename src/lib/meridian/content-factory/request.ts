/**
 * The engine's production request built from a Content Factory session (engine contract request.ts, Bible 6.1). Pure: it reads the
 * session, calls nothing and writes nothing.
 *
 * What maps, and from where:
 * - format.referenceVideo: the session's reference video file. format.formatId: named after that file's SHA-256, so the same reference
 *   is the same format. format.keep: the genes the person ticked. format.change: the person's instructions and the snapshots of the
 *   Meridian records they attached, as plain text. The engine treats them as data.
 * - script: the messages marked as script lines, in order, each with the beat role the person gave it. The engine consumes a script and
 *   does not write one (Bible 1), so a session with no script line is refused by the schema and says so.
 * - page: the kits of an attached theme page. constraints: the length, budget and priority the person set. The aspect is 9:16, the only
 *   one the engine renders.
 *
 * Nothing is defaulted: a field the session does not give stays absent, and the engine's own schema (src/engine/api requestProblems)
 * names it. Each problem is then put in plain words.
 */
import { requestProblems } from "../../../engine/api/index.ts";
import { productionRequestSchema, type ProductionRequest } from "../../../engine/contracts/request.ts";
import { engineRequestIdFor } from "../factory/engine-request.ts";
import type { PageRequestKits } from "../pages/model.ts";
import { referenceVideoUri } from "./files.ts";
import type { Attachment, FileAttachment, Message, SessionSettings, SourceAttachment } from "./model.ts";
import { SOURCE_PAGE_LABELS } from "./model.ts";

export type SessionForRequest = {
  id: string;
  organizationId: string;
  createdAt: string;
  settings: SessionSettings;
  messages: Pick<Message, "text" | "beatRole" | "attachments">[];
  /** The kits of the theme page attached as a source, read at start time. Null when no theme page is attached. */
  themePage: PageRequestKits | null;
};

export type RequestBuild =
  | { status: "ready"; request: ProductionRequest }
  | { status: "incomplete"; candidate: Record<string, unknown>; problems: string[] };

/** Plain words for each field of the request the engine's schema can name. A field not listed is named as the schema names it. */
const PROBLEM_WORDS: Record<string, string> = {
  requestId: "The session has no usable creation time, so no request id can be made.",
  "format.referenceVideo": "Attach a reference video from your computer and mark it as the reference. The engine studies how it is made; its footage is never used.",
  "format.formatId": "Attach a reference video from your computer and mark it as the reference. The engine studies how it is made; its footage is never used.",
  "format.keep": "Choose which parts of the reference to keep.",
  "script.language": "Set the language of the script.",
  "script.beats": "Add the script: send at least one message marked as a script line (hook, setup, item, proof, twist, payoff or call to action). The engine reads a script; it does not write one.",
  "page.pageId": "Attach a theme page from the Pages screen. Its style, persona and voice kits are used.",
  "page.styleKitId": "The attached theme page has no style kit. Set one on the page.",
  "page.voiceId": "The attached theme page has no voice kit. Set one on the page.",
  "constraints.maxMs": "Set the length of the video in seconds.",
  "constraints.budgetUsd": "Set the budget for this video. No default is used.",
  "constraints.priority": "Choose a priority.",
};

export function problemWords(path: string): string {
  const exact = PROBLEM_WORDS[path];
  if (exact) return exact;
  const beat = /^script\.beats\.\d+/.exec(path);
  if (beat) return "A script line is empty. Each script line needs text.";
  return `The engine needs a valid value for ${path}.`;
}

function present(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function attachmentsOf(session: SessionForRequest): Attachment[] {
  return session.messages.flatMap((message) => message.attachments);
}

export function referenceOf(attachments: readonly Attachment[]): FileAttachment | null {
  return (attachments.find((item) => item.kind === "file" && item.purpose === "reference_video") as FileAttachment | undefined) ?? null;
}

function sourceLine(source: SourceAttachment): string {
  return `Context from ${SOURCE_PAGE_LABELS[source.page]}: ${source.snapshot}`;
}

/** Maps a session to the engine's request and checks it with the engine's own schema. */
export function buildProductionRequest(session: SessionForRequest): RequestBuild {
  const attachments = attachmentsOf(session);
  const reference = referenceOf(attachments);
  const instructions = session.messages
    .filter((message) => message.beatRole === null)
    .map((message) => message.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const sources = attachments.filter((item): item is SourceAttachment => item.kind === "source").map(sourceLine);
  const beats = session.messages
    .filter((message) => message.beatRole !== null)
    .map((message, index) => ({ beatId: `b${index + 1}`, role: message.beatRole, text: message.text.trim() }));
  const settings = session.settings;
  const page = session.themePage;

  const candidate = present({
    schema: "meridian.production_request/v1",
    requestId: engineRequestIdFor(`content-factory:${session.id}`, session.createdAt) ?? undefined,
    workspaceId: session.organizationId,
    format: present({
      formatId: reference ? `ref_${reference.sha256.slice(0, 24)}` : undefined,
      referenceVideo: reference ? referenceVideoUri(reference.storageKey) : undefined,
      keep: settings.keepGenes,
      change: [...instructions, ...sources],
    }),
    script: present({ language: settings.language ?? undefined, beats: beats.length > 0 ? beats : undefined }),
    visualRequests: [],
    page: present({
      pageId: page?.pageId,
      styleKitId: page?.styleKitId ?? undefined,
      personaId: page?.personaId ?? undefined,
      voiceId: page?.voiceId ?? undefined,
    }),
    constraints: present({
      aspect: "9:16",
      maxMs: settings.maxSeconds === null ? undefined : settings.maxSeconds * 1000,
      budgetUsd: settings.budgetUsd ?? undefined,
      priority: settings.priority ?? undefined,
    }),
    output: { master: true },
  });

  const paths = requestProblems(candidate);
  if (paths.length === 0) return { status: "ready", request: productionRequestSchema.parse(candidate) };
  // With no theme page attached, the page's kit fields are one gap: the page itself.
  const named = paths.map((path) => (page === null && path.startsWith("page.") ? "page.pageId" : path));
  return { status: "incomplete", candidate, problems: [...new Set(named.map(problemWords))] };
}
