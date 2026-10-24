// Editing the brand frame of a ready brief (prompt 14). A person changes the platform, the budget, the visual references and the success
// criteria; the copy is judged as written and is not edited here. A used or rejected brief is kept as it was. Every change is audited with
// the fields it named, so the history of a brief's frame can be read back. The server function that calls this is in ./actions.ts.

import { applyFrameEdit, frameEditProblem, parseFrame, type BriefFrame, type FrameEdit } from "../brief/frame.ts";
import { requireBrand } from "../brand-membership.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { audit } from "../machine-shared.ts";

export async function updateBriefFrame(
  sql: Sql,
  userId: string,
  input: { brandId: string; briefId: string; edit: FrameEdit },
): Promise<{ frame: BriefFrame }> {
  const access = await requireBrand(sql, userId, input.brandId, "member");
  const problem = frameEditProblem(input.edit);
  if (problem) throw new Error(problem);
  const fields = Object.keys(input.edit).sort();
  return withTransaction(sql, async (tx) => {
    const rows = await tx<{ frame: unknown; status: string }>`
      select frame, status from briefs
      where id = ${input.briefId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId}
      limit 1 for update
    `;
    const row = rows[0];
    if (!row) throw new Error("That brief is not in this brand.");
    if (row.status !== "ready") throw new Error("Only a ready brief's frame can be changed. A used or rejected brief is kept as it was.");
    const next = applyFrameEdit(parseFrame(row.frame), input.edit);
    const updated = await tx<{ id: string }>`
      update briefs set frame = ${JSON.stringify(next)}
      where id = ${input.briefId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId} and status = 'ready'
      returning id
    `;
    if (updated.length === 0) throw new Error("The brief changed while this was saved, so nothing was changed. Refresh and try again.");
    await audit(tx, {
      organizationId: access.organizationId,
      brandId: input.brandId,
      actorId: userId,
      action: "brief.frame_edited",
      objectType: "brief",
      objectId: input.briefId,
      metadata: { fields: fields.join(",") },
    });
    return { frame: next };
  });
}
