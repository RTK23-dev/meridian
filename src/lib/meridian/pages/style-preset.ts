// Installs the 3D data explainer's style kit into the workspace, so a theme page can name it (B16, decision Q30 D). The kit is the preset's own
// style kit (engine presets, styleKitSchema). Writing the same body again finds the same row, so the install is repeatable and changes nothing
// the second time. The page keeps the kit id only when the person saves the page.

import { writeKit } from "../../../engine/jobs/kit-store.ts";
import { threeDDataExplainerKit } from "../../../engine/presets/three-d-data-explainer.ts";
import type { Sql } from "../learning/store.ts";

export async function installThreeDStyleKit(sql: Sql, input: { organizationId: string }): Promise<{ kitId: string }> {
  const stored = await writeKit(sql, { organizationId: input.organizationId, kind: "style", body: threeDDataExplainerKit });
  return { kitId: stored.kitId };
}
