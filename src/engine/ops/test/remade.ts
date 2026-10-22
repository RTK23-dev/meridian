// The recorded answers of one remade take: its take, its verdict (accepted) and the cut edit on it. The chain world answers the first pass
// of a request; a remake starts a new epoch, so its take, verdict and edit are answered here, as the remake tests always did. Fixtures only.

import { writeArtifact } from "../../jobs/artifact-store.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { newId } from "../../contracts/index.ts";
import { cleanRender } from "../../review/test/render.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { answerStage, gateResult, type RequestIds } from "./chain.ts";

/** Answers the remade take of `shot` in epoch 1 (take, verdict, edit) for a request whose ids are `ids`. Returns the take and the edit it cut. */
export async function answerRemadeChain(sql: Sql, input: { organizationId: string; requestId: string; shot: string; ids: RequestIds; now: string }): Promise<{ takeId: string; edlId: string }> {
  const { organizationId, requestId, shot, ids, now } = input;
  const takeId = newId("take_");
  const takeArtifact = (
    await writeArtifact(sql, {
      organizationId,
      requestId,
      stage: "produce_shot",
      type: "take",
      body: { ...ids.value(fx.take1Fixture), takeId, shotId: shot, attempt: 2 },
      createdAt: now,
    })
  ).artifactId;
  await answerStage(sql, {
    organizationId,
    requestId,
    stage: "produce_shot",
    subjectId: shot,
    output: { stage: "produce_shot", subjectId: shot, shotId: shot, epoch: 1, takeId, artifacts: { [`take:${takeId}`]: takeArtifact } },
  });

  const verdict = { takeId, pass: true, confidence: 0.9, checks: [{ rule: "slop.clean", pass: true }], action: "accept" as const };
  const verdictArtifact = (await writeArtifact(sql, { organizationId, requestId, stage: "check_take", type: "take_verdict", body: verdict, createdAt: now })).artifactId;
  await answerStage(sql, {
    organizationId,
    requestId,
    stage: "check_take",
    subjectId: takeId,
    output: { stage: "check_take", subjectId: takeId, shotId: shot, takeId, gate: gateResult("take", requestId, true), verdict, artifacts: { [`verdict:${takeId}`]: verdictArtifact } },
  });

  const edlId = newId("edl_");
  const edlArtifact = (await writeArtifact(sql, { organizationId, requestId, stage: "edit", type: "edl", body: { ...ids.value(cleanRender().edl), edlId }, createdAt: now })).artifactId;
  await answerStage(sql, {
    organizationId,
    requestId,
    stage: "edit",
    subjectId: requestId,
    output: { stage: "edit", subjectId: requestId, gate: gateResult("edit", requestId, true), edlId, artifacts: { [`edl:${edlId}`]: edlArtifact } },
  });
  return { takeId, edlId };
}
