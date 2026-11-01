// The roles a cookbook may give instructions to (round 3, K15). A leaf module: it imports only zod, so the browser can load the role list
// without the rest of the engine contracts (which use node:crypto). request.ts re-exports these, so there is one definition.

import { z } from "zod";

export const COOKBOOK_INSTRUCTION_ROLES = ["script", "plan", "visual", "voice", "edit", "critic", "agent"] as const;
export const cookbookInstructionRoleSchema = z.enum(COOKBOOK_INSTRUCTION_ROLES);
