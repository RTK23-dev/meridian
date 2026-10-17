// The `request` gate (Bible 12.1, and 6.1 steps 1 to 7). Pure: the kits, the claims and the format minimum are passed in
// as data, and the gate never reads a store. Unknown means fail: a missing kit, a missing classification or a missing
// minimum is a failing check, which routes to review (12.4) rather than passing.

import { thresholds } from "../../config/thresholds.ts";
import {
  productionRequestSchema,
  validatedRequestSchema,
  type CharacterSheet,
  type GateCheck,
  type GateResult,
  type Persona,
  type ProductKit,
  type StyleKit,
  type ValidatedRequest,
  type VoiceKit,
} from "../../contracts/index.ts";
import { mustAllowedTypes } from "../../plan/filter.ts";
import { visualPropertySchema, type VisualProperty } from "../../plan/tables.ts";
import { usdAtMost } from "../../plan/cost.ts";
import { check, gateResult, notEvaluated } from "./common.ts";

/** What the classifier said about one visual request (7.3). Keyed by beat and the request text. */
export type VisualClassification = {
  beatId: string;
  want: string;
  properties: readonly VisualProperty[];
};

export type RequestGateInput = {
  /** The ProductionRequest as received. Parsed here. */
  request: unknown;
  /** The ValidatedRequest from intake. Parsed here. */
  validated: unknown;
  /** The kits the request resolved to, or undefined where a kit was not found. */
  kits: {
    styleKit?: StyleKit;
    persona?: Persona;
    voice?: VoiceKit;
    characters: readonly CharacterSheet[];
    productKit?: ProductKit;
  };
  /** The outcome of the VideoDNA lookup (6.1 step 5), or undefined when the lookup has not run. */
  dnaLookup: "cached" | "miss" | undefined;
  /** The cheapest plan for this many beats (6.1 step 6), or undefined when it has not been computed. */
  formatMinimumUsd: number | undefined;
  /** The classification of every visual request (6.1 step 7). A must without one fails. */
  classifications: readonly VisualClassification[];
};

const propertySchema = visualPropertySchema;

const RULES = [
  "kits_exist",
  "kit_versions_match",
  "claims_approved",
  "estimated_speech_within_maxMs_plus_10pct",
  "dna_lookup_resolved",
  "budget_above_format_minimum",
  "every_must_deliverable",
  "forbidden_terms_absent",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkRequest(input: RequestGateInput): GateResult {
  const parsedRequest = productionRequestSchema.safeParse(input.request);
  const parsedValidated = validatedRequestSchema.safeParse(input.validated);
  const subjectId = parsedRequest.success ? parsedRequest.data.requestId : "request:unparsed";

  if (!parsedRequest.success || !parsedValidated.success) {
    const parts: string[] = [];
    if (!parsedRequest.success) {
      parts.push(`the production request does not parse: ${parsedRequest.error.message}`);
    }
    if (!parsedValidated.success) {
      parts.push(`the validated request does not parse: ${parsedValidated.error.message}`);
    }
    const checks: GateCheck[] = [check("schema_valid", false, { detail: parts.join("; ") })];
    for (const rule of RULES) {
      checks.push(notEvaluated(rule, "the request or validated request is invalid"));
    }
    return gateResult("request", subjectId, checks);
  }

  const request = parsedRequest.data;
  const validated: ValidatedRequest = parsedValidated.data;
  const checks: GateCheck[] = [check("schema_valid", true)];

  // Kits (6.1 step 2): every kit the request names must exist, match the id it names, and carry the version intake used.
  const missing: string[] = [];
  const wrongVersion: string[] = [];
  const kitVersion = (label: string, id: string, version: number, kit: { version: number } | undefined): void => {
    if (kit === undefined) {
      missing.push(`${label} ${id}`);
      return;
    }
    if (kit.version !== version) {
      wrongVersion.push(`${label} ${id} is v${kit.version}, intake used v${version}`);
    }
  };

  const styleRef = validated.kits.styleKit;
  kitVersion("style kit", styleRef.id, styleRef.version, input.kits.styleKit);
  if (request.page.styleKitId !== styleRef.id) {
    missing.push(`style kit ${request.page.styleKitId} does not match the validated ${styleRef.id}`);
  }

  if (request.page.personaId !== undefined) {
    const personaRef = validated.kits.persona;
    if (personaRef === undefined || personaRef.id !== request.page.personaId) {
      missing.push(`persona ${request.page.personaId} is not in the validated request`);
    } else {
      kitVersion("persona", personaRef.id, personaRef.version, input.kits.persona);
    }
  }

  if (input.kits.voice === undefined || input.kits.voice.voiceId !== request.page.voiceId) {
    missing.push(`voice ${request.page.voiceId}`);
  }
  if (validated.kits.voiceId !== request.page.voiceId) {
    missing.push(`validated voice ${validated.kits.voiceId} does not match the request ${request.page.voiceId}`);
  }

  for (const characterId of request.page.characterIds ?? []) {
    const ref = validated.kits.characters.find((item) => item.id === characterId);
    const kit = input.kits.characters.find((item) => item.characterId === characterId);
    if (ref === undefined) {
      missing.push(`character ${characterId} is not in the validated request`);
    } else {
      kitVersion("character", ref.id, ref.version, kit);
    }
  }

  if (request.product !== undefined) {
    const productRef = validated.kits.productKit;
    const kit = input.kits.productKit;
    if (productRef === undefined || productRef.id !== request.product.productKitId) {
      missing.push(`product kit ${request.product.productKitId} is not in the validated request`);
    } else {
      kitVersion("product kit", productRef.id, productRef.version, kit);
    }
    if (kit !== undefined && kit.sku !== request.product.sku) {
      missing.push(`product kit ${kit.productKitId} is for SKU ${kit.sku}, not ${request.product.sku}`);
    }
  }

  checks.push(
    check("kits_exist", missing.length === 0, {
      detail: missing.length === 0 ? "every kit the request names resolved" : missing.join("; "),
    }),
  );
  checks.push(
    check("kit_versions_match", wrongVersion.length === 0, {
      detail: wrongVersion.length === 0 ? "every resolved kit has the version intake used" : wrongVersion.join("; "),
    }),
  );

  // Claims (6.1 step 3): every claim the product names must be approved in its product kit.
  if (request.product === undefined) {
    checks.push(check("claims_approved", true, { detail: "no product on this request" }));
  } else if (input.kits.productKit === undefined) {
    checks.push(check("claims_approved", false, { detail: "product kit missing, so no claim can be checked" }));
  } else {
    const approved = new Set(input.kits.productKit.approvedClaims.map((claim) => claim.claimId));
    const unapproved = request.product.claimIds.filter((claimId) => !approved.has(claimId));
    checks.push(
      check("claims_approved", unapproved.length === 0, {
        detail: unapproved.length === 0 ? "every claim is approved" : `not approved: ${unapproved.join(", ")}`,
      }),
    );
  }

  // Speech length (6.1 step 4, 12.1): the estimate must sit within maxMs plus the configured overrun share.
  const maxMs = request.constraints.maxMs;
  const speechLimit = maxMs * (1 + thresholds.intake.speechOverrunShare.value);
  const speechMs = validated.estimatedSpeechMs;
  checks.push(
    check("estimated_speech_within_maxMs_plus_10pct", speechMs <= speechLimit + 1e-9, {
      value: speechMs,
      limit: speechLimit,
      detail: speechMs <= speechLimit + 1e-9 ? undefined : `${speechMs} ms is over ${speechLimit} ms`,
    }),
  );

  // VideoDNA lookup (6.1 step 5): the lookup must have run, and its outcome must agree with the validated request.
  const cachedDna = validated.cachedVideoDnaId;
  let dnaPass = false;
  let dnaDetail = "the VideoDNA lookup has not run";
  if (input.dnaLookup === "cached") {
    dnaPass = cachedDna !== undefined;
    dnaDetail = dnaPass ? "cached VideoDNA used" : "the lookup says cached, but the validated request has no VideoDNA id";
  } else if (input.dnaLookup === "miss") {
    dnaPass = cachedDna === undefined;
    dnaDetail = dnaPass ? "no cached VideoDNA; analysis runs" : "the lookup says miss, but the validated request has a VideoDNA id";
  }
  checks.push(check("dna_lookup_resolved", dnaPass, { detail: dnaDetail }));

  // Budget (6.1 step 6): the request budget must cover the cheapest plan for its beats. A brief has no beats until write_script writes
  // them, so its minimum is computed there, and the check is not part of intake (contract v8, the write_script stage).
  const budgetUsd = request.constraints.budgetUsd;
  if (input.formatMinimumUsd === undefined && request.brief !== undefined) {
    // Deferred: write_script checks the minimum of the written beats and fails the stage when the budget is below it.
  } else if (input.formatMinimumUsd === undefined) {
    checks.push(check("budget_above_format_minimum", false, { detail: "the format minimum has not been computed" }));
  } else {
    const minimum = input.formatMinimumUsd;
    checks.push(
      check("budget_above_format_minimum", usdAtMost(minimum, budgetUsd), {
        value: budgetUsd,
        limit: minimum,
        detail: usdAtMost(minimum, budgetUsd) ? undefined : `budget ${budgetUsd} USD is below the minimum ${minimum} USD`,
      }),
    );
  }

  // Must requests (6.1 step 7, 7.3): every must needs a classification whose properties some type can deliver.
  const problems: string[] = [];
  // A script request names its beats here. A brief request has none yet, so every visual request it sends names a beat that does not
  // exist: the contract does not refuse that, so intake refuses it here (contract v8, open point 2).
  const beatIds = new Set((request.script?.beats ?? []).map((beat) => beat.beatId));
  const musts = request.visualRequests.filter((item) => item.strength === "must");
  if (request.brief !== undefined) {
    for (const item of request.visualRequests) {
      problems.push(`"${item.want}" names beat ${item.beatId}, which a brief does not have until its script is written`);
    }
  }
  for (const must of request.script === undefined ? [] : musts) {
    if (!beatIds.has(must.beatId)) {
      problems.push(`must "${must.want}" names beat ${must.beatId}, which the script does not have`);
      continue;
    }
    const classification = input.classifications.find(
      (item) => item.beatId === must.beatId && item.want === must.want,
    );
    if (classification === undefined) {
      problems.push(`must "${must.want}" has no classification`);
      continue;
    }
    const properties = propertySchema.array().safeParse(classification.properties);
    if (!properties.success || properties.data.length === 0) {
      problems.push(`must "${must.want}" has no valid properties`);
      continue;
    }
    if (mustAllowedTypes([{ strength: "must", want: must.want, properties: properties.data }])?.length === 0) {
      problems.push(`no visual type can deliver must "${must.want}"`);
    }
  }
  checks.push(
    check("every_must_deliverable", problems.length === 0, {
      detail: mustDetail(musts.length, problems),
    }),
  );

  // Claims policy (13, ProductKit.forbidden): words the product kit forbids must not appear in the script or requests.
  if (request.product === undefined) {
    checks.push(check("forbidden_terms_absent", true, { detail: "no product on this request" }));
  } else if (input.kits.productKit === undefined) {
    checks.push(notEvaluated("forbidden_terms_absent", "product kit missing"));
  } else {
    // The words the request carries: the script's beats, or a brief's own text and its sources (a brief has no script yet).
    const spoken = request.script?.beats.map((beat) => beat.text) ?? [request.brief?.text ?? "", ...(request.brief?.sources.map((source) => source.text) ?? [])];
    const texts = [...spoken, ...request.visualRequests.map((item) => item.want)];
    const hits = input.kits.productKit.forbidden.filter((term) => {
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
      return texts.some((text) => pattern.test(text));
    });
    checks.push(
      check("forbidden_terms_absent", hits.length === 0, {
        detail: hits.length === 0 ? "no forbidden term" : `forbidden terms found: ${hits.join(", ")}`,
      }),
    );
  }

  return gateResult("request", request.requestId, checks);
}

function mustDetail(count: number, problems: readonly string[]): string {
  if (problems.length > 0) {
    return problems.join("; ");
  }
  return count === 0 ? "no must requests" : `${count} must requests deliverable`;
}
