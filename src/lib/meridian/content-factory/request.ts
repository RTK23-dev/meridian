/**
 * The engine's production request built from a Content Factory session (engine contract request.ts, Bible 6.1). Pure: it reads the
 * session, calls nothing and writes nothing.
 *
 * What maps, and from where:
 * - format.referenceVideo: the session's reference video file. format.formatId: named after that file's SHA-256, so the same reference
 *   is the same format. format.keep: the genes the person ticked.
 * - By default the request carries a brief and the engine writes the script (contract v8, write_script). The chat instructions are the
 *   brief's text. The snapshots of the attached Meridian records and the text files (each at most TEXT_FILE_MAX_CHARS characters) are its
 *   sources, labelled by page or by file name. Every other file that is not the reference (images and PDFs) is an attachment with its
 *   store:// uri, media type and a note. The instructions and the text files share the brief's total limit (BRIEF_TEXT_MAX).
 * - When the person marked script lines, the request carries that script instead (never both): the lines in order, each with its beat
 *   role, in the language the person set. The instructions, record snapshots and text files then go to format.change as plain text.
 * - page: the kits of an attached theme page. constraints: the length, budget and priority the person set. The aspect is 9:16, the only
 *   one the engine renders.
 *
 * All of it is data to the engine, never instructions. Nothing is defaulted: a field the session does not give stays absent, and the
 * engine's own schema (src/engine/api requestProblems) names it. Each problem is then put in plain words.
 */
import { requestProblems } from "../../../engine/api/index.ts";
import { BRIEF_LIST_MAX, BRIEF_SOURCE_TEXT_MAX, BRIEF_TEXT_MAX, productionRequestSchema, type ProductionRequest } from "../../../engine/contracts/request.ts";
import { engineRequestIdFor } from "../factory/engine-request.ts";
import type { PageRequestKits } from "../pages/model.ts";
import { characterCount, referenceVideoUri } from "./files.ts";
import { type Attachment, type FileAttachment, type Message, PDF_TEXT_NOTE, type SessionSettings, type SourceAttachment } from "./model.ts";
import { SOURCE_PAGE_LABELS } from "./model.ts";

export type SessionForRequest = {
  id: string;
  organizationId: string;
  createdAt: string;
  /** Zero for the first video. A later revision gets its own request id. Omitted means the first video. */
  revision?: number;
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
  "script.language": "You wrote script lines, so set the language they are written in. Without script lines, the engine writes the script and chooses the language.",
  "brief.text": "Tell the engine what the video is for: send at least one instruction in the chat. The engine writes the script from it.",
  "brief.sources": `Attach at most ${BRIEF_LIST_MAX} Meridian records and text files to one session.`,
  "brief.attachments": `Attach at most ${BRIEF_LIST_MAX} files besides the reference video to one session.`,
  "page.pageId": "Attach a theme page from the Pages screen. Its style, persona and voice kits are used.",
  "page.styleKitId": "The attached theme page has no style kit. Set one on the page.",
  "page.voiceId": "The attached theme page has no voice kit. Set one on the page.",
  "constraints.maxMs": "Set the length of the video in seconds.",
  "constraints.budgetUsd": "Set the budget for this video. No default is used.",
  "constraints.priority": "Choose a priority.",
};

/** The instructions and the text files together are over the brief's total limit. The engine checks the instructions alone, so this is ours. */
const BRIEF_TOTAL_WORDS = `Keep the instructions and text files to ${BRIEF_TEXT_MAX} characters in all.`;

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

/** A text file read into the brief: a material file that carries its text. An image's content is its measured size, not text. */
function isTextFile(item: Attachment): item is FileAttachment {
  return item.kind === "file" && item.purpose !== "reference_video" && item.content !== null && !item.mediaType.startsWith("image/");
}

/** A file that goes to the engine as an attachment: not the reference and not read into the brief. */
function isMaterialFile(item: Attachment): item is FileAttachment {
  return item.kind === "file" && item.purpose !== "reference_video" && (item.content === null || item.mediaType.startsWith("image/"));
}

const IMAGE_SIZE = /^(\d+)×(\d+)$/;

/** The note a brief attachment carries. A measured image names its size. A PDF whose text was not readable says so. */
function attachmentNote(file: FileAttachment): string {
  if (file.mediaType.startsWith("image/") && file.content && IMAGE_SIZE.test(file.content)) return `${file.fileName}: ${file.content}`;
  return file.mediaType === "application/pdf" ? `${file.fileName}: ${PDF_TEXT_NOTE}` : file.fileName;
}

function sourceLine(source: SourceAttachment): string {
  return `Context from ${SOURCE_PAGE_LABELS[source.page]}: ${source.snapshot}`;
}

function textFileLine(file: FileAttachment): string {
  return `Context from the text file ${file.fileName}: ${file.content ?? ""}`;
}

/**
 * The lines the decision panel lists under Inputs: what each file does on its way to the engine. A text file is read into the brief
 * (its length is shown). A PDF whose text could not be read says so. An image whose header gave a size shows that size. The
 * reference video has no line here.
 */
export function inputNotes(attachments: readonly Attachment[]): string[] {
  return attachments.flatMap((item): string[] => {
    if (item.kind !== "file" || item.purpose === "reference_video") return [];
    if (item.mediaType.startsWith("image/") && item.content && IMAGE_SIZE.test(item.content)) return [`${item.fileName}: ${item.content}. Pixels were not read.`];
    if (item.content !== null && !item.mediaType.startsWith("image/")) return [`${item.fileName}: read into the brief, ${characterCount(item.content)} characters.`];
    return item.mediaType === "application/pdf" ? [attachmentNote(item)] : [];
  });
}

/** Maps a session to the engine's request and checks it with the engine's own schema. */
export function buildProductionRequest(session: SessionForRequest): RequestBuild {
  const attachments = attachmentsOf(session);
  const reference = referenceOf(attachments);
  const instructions = session.messages
    .filter((message) => message.beatRole === null)
    .map((message) => message.text.trim())
    .filter(Boolean);
  const materials = attachments.filter(isMaterialFile);
  const textFiles = attachments.filter(isTextFile);
  const beats = session.messages
    .filter((message) => message.beatRole !== null)
    .map((message, index) => ({ beatId: `b${index + 1}`, role: message.beatRole, text: message.text.trim() }));
  const scripted = beats.length > 0;
  const settings = session.settings;
  const page = session.themePage;

  const briefText = instructions.join("\n\n");
  // Record sources and text files, in the order the person attached them. Each is the brief's source: its label and its text.
  const sources = attachments.flatMap((item): Array<{ label: string; text: string }> => {
    if (item.kind === "source") return [{ label: SOURCE_PAGE_LABELS[item.page], text: item.snapshot.slice(0, BRIEF_SOURCE_TEXT_MAX) }];
    return isTextFile(item) ? [{ label: item.fileName, text: item.content ?? "" }] : [];
  });
  // The instructions and the text files share the brief's total limit. Record snapshots are not counted, as before.
  const briefCharacters = characterCount(briefText) + textFiles.reduce((total, file) => total + characterCount(file.content ?? ""), 0);
  const overTotal = !scripted && briefCharacters > BRIEF_TEXT_MAX;

  // A brief over a limit is refused by the schema rather than cut, so nothing the person wrote is dropped silently.
  const brief = scripted
    ? undefined
    : {
        ...(briefText ? { text: briefText } : {}),
        sources,
        attachments: materials.map((file) => ({ uri: referenceVideoUri(file.storageKey), mediaType: file.mediaType, note: attachmentNote(file) })),
      };
  // A script request has no brief, so the records and text files travel as plain change lines, in the order attached.
  const context = attachments.flatMap((item) => (item.kind === "source" ? [sourceLine(item)] : isTextFile(item) ? [textFileLine(item)] : []));

  const revision = session.revision ?? 0;
  const seed = revision > 0 ? `content-factory:${session.id}:r${revision}` : `content-factory:${session.id}`;
  const candidate = present({
    schema: "meridian.production_request/v1",
    requestId: engineRequestIdFor(seed, session.createdAt) ?? undefined,
    workspaceId: session.organizationId,
    format: present({
      formatId: reference ? `ref_${reference.sha256.slice(0, 24)}` : undefined,
      referenceVideo: reference ? referenceVideoUri(reference.storageKey) : undefined,
      keep: settings.keepGenes,
      change: scripted ? [...instructions.map((text) => text.replace(/\s+/g, " ")), ...context] : [],
    }),
    script: scripted ? present({ language: settings.language ?? undefined, beats }) : undefined,
    brief,
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
  if (paths.length === 0 && !overTotal) return { status: "ready", request: productionRequestSchema.parse(candidate) };
  // With no theme page attached, the page's kit fields are one gap: the page itself.
  const named = paths.map((path) => (page === null && path.startsWith("page.") ? "page.pageId" : path.replace(/^(brief\.(?:sources|attachments))\..*$/, "$1")));
  const words = named.map((path) =>
    path === "brief.text" && briefText.length > BRIEF_TEXT_MAX ? `Keep the instructions to ${BRIEF_TEXT_MAX} characters in all.` : problemWords(path),
  );
  return { status: "incomplete", candidate, problems: [...new Set([...words, ...(overTotal ? [BRIEF_TOTAL_WORDS] : [])])] };
}
