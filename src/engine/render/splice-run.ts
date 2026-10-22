// Runs a splice plan (splice.ts): the window the change re-renders comes from a window render, the kept spans are cut from the previous
// master, and one join puts them in order. The ports are injected: the window render is the one that is not built yet (HyperFrames renders
// whole compositions here; a window render is the open piece), so until it is connected the outcome is not_connected and the caller keeps
// the full render, as the plan says. Nothing is stored for a failed or unconnected run, and no output is claimed without the join.

import { EngineError } from "../contracts/errors.ts";
import type { MediaEditors } from "../media/splice.ts";
import type { Span, SplicePlan } from "./splice.ts";

/** The window's own media: its timeline starts at the window's start, so a keep segment and the window join with no offset. */
export type WindowRender = { status: "rendered"; bytes: Uint8Array<ArrayBuffer> } | { status: "not_connected"; reason: string } | { status: "failed"; reason: string };

export type SpliceRunPorts = {
  renderWindow(input: { window: Span }): Promise<WindowRender>;
  /** The bytes of the previous master. */
  readMaster(): Promise<Uint8Array<ArrayBuffer>>;
  /** Stores the joined master and returns its uri. */
  storeMaster(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  editors: Pick<MediaEditors, "splice">;
};

export type SpliceOutcome =
  | { status: "spliced"; masterUri: string; segments: number; plannedMs: number }
  | { status: "full"; reason: string }
  | { status: "not_connected"; reason: string }
  | { status: "failed"; reason: string };

export async function runSplice(plan: SplicePlan, ports: SpliceRunPorts): Promise<SpliceOutcome> {
  if (plan.status === "full") return { status: "full", reason: plan.reason };
  const window = await ports.renderWindow({ window: plan.window });
  if (window.status === "not_connected") return { status: "not_connected", reason: window.reason };
  if (window.status === "failed") return { status: "failed", reason: window.reason };
  try {
    const master = await ports.readMaster();
    const segments = plan.segments.map((segment) =>
      segment.kind === "keep"
        ? { source: { kind: "bytes" as const, bytes: master }, inMs: segment.span.fromMs, outMs: segment.span.toMs }
        : { source: { kind: "bytes" as const, bytes: window.bytes }, inMs: 0, outMs: segment.span.toMs - segment.span.fromMs },
    );
    const joined = await ports.editors.splice({ segments });
    const masterUri = await ports.storeMaster(Buffer.from(joined.base64, "base64"));
    const plannedMs = plan.segments.reduce((total, segment) => total + (segment.span.toMs - segment.span.fromMs), 0);
    return { status: "spliced", masterUri, segments: plan.segments.length, plannedMs };
  } catch (error) {
    if (error instanceof EngineError) return { status: "failed", reason: error.message };
    return { status: "failed", reason: "the splice did not finish, so no master was stored" };
  }
}

/** The production window port until the window renderer is built: it says so, and renders nothing. */
export function unbuiltWindowRender(): (input: { window: Span }) => Promise<WindowRender> {
  return async () => ({
    status: "not_connected",
    reason: "the window render is not built: HyperFrames renders whole compositions here, so a changed window renders the whole video",
  });
}
