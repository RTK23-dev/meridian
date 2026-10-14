import assert from "node:assert/strict";
import test from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { gateResultSchema, type GateResult } from "../../contracts/index.ts";
import {
  budgetReservationFixture,
  characterSheetFixture,
  personaFixture,
  productKitFixture,
  productionRequestFixture,
  styleKitFixture,
  validatedRequestFixture,
  voiceKitFixture,
} from "../../contracts/fixtures/index.ts";
import { checkRequest, type RequestGateInput } from "./request.ts";

type Mutable = Record<string, unknown>;

function fixtureInput(overrides: Partial<RequestGateInput> = {}): RequestGateInput {
  return {
    request: structuredClone(productionRequestFixture),
    validated: structuredClone(validatedRequestFixture),
    kits: {
      styleKit: structuredClone(styleKitFixture),
      persona: structuredClone(personaFixture),
      voice: structuredClone(voiceKitFixture),
      characters: [structuredClone(characterSheetFixture)],
      productKit: structuredClone(productKitFixture),
    },
    dnaLookup: "miss",
    formatMinimumUsd: budgetReservationFixture.estimateUsd,
    classifications: [{ beatId: "b3", want: "the blender on a clean kitchen counter", properties: ["real_product"] }],
    ...overrides,
  };
}

/** The named check, or a test failure if the gate did not emit it. */
function check(result: GateResult, rule: string) {
  const found = result.checks.find((item) => item.rule === rule);
  assert.ok(found, `check ${rule} is present`);
  return found;
}

test("the fixture request passes every check, and the result is a valid GateResult", () => {
  const result = checkRequest(fixtureInput());
  assert.equal(result.gate, "request");
  assert.equal(result.pass, true, JSON.stringify(result.checks.filter((item) => !item.pass)));
  assert.equal(gateResultSchema.safeParse(result).success, true);
  assert.equal(result.failingShotIds, undefined);
  assert.equal(result.subjectId, productionRequestFixture.requestId);
});

test("an invalid request fails schema_valid and names every other check as not evaluated", () => {
  const request = structuredClone(productionRequestFixture) as unknown as Mutable;
  delete request.schema;
  const result = checkRequest(fixtureInput({ request }));
  assert.equal(result.pass, false);
  assert.equal(check(result, "schema_valid").pass, false);
  assert.match(check(result, "kits_exist").detail ?? "", /not evaluated/);
  assert.equal(result.subjectId, "request:unparsed");
});

test("kits: a missing style kit fails kits_exist and names it", () => {
  const result = checkRequest(fixtureInput({ kits: { ...fixtureInput().kits, styleKit: undefined } }));
  assert.equal(check(result, "kits_exist").pass, false);
  assert.match(check(result, "kits_exist").detail ?? "", /style kit sk_fixture/);
  assert.equal(result.pass, false);
});

test("kits: a resolved kit at another version fails kit_versions_match", () => {
  const kits = fixtureInput().kits;
  const result = checkRequest(fixtureInput({ kits: { ...kits, styleKit: { ...styleKitFixture, version: 4 } } }));
  assert.equal(check(result, "kit_versions_match").pass, false);
  assert.match(check(result, "kit_versions_match").detail ?? "", /v4, intake used v3/);
});

test("kits: a missing voice, a missing character and a missing product kit each fail kits_exist", () => {
  const kits = fixtureInput().kits;
  assert.equal(checkRequest(fixtureInput({ kits: { ...kits, voice: undefined } })).checks.find((item) => item.rule === "kits_exist")?.pass, false);
  assert.equal(checkRequest(fixtureInput({ kits: { ...kits, characters: [] } })).checks.find((item) => item.rule === "kits_exist")?.pass, false);
  assert.equal(checkRequest(fixtureInput({ kits: { ...kits, productKit: undefined } })).checks.find((item) => item.rule === "kits_exist")?.pass, false);
});

test("kits: a product kit for another SKU fails kits_exist", () => {
  const kits = fixtureInput().kits;
  const result = checkRequest(fixtureInput({ kits: { ...kits, productKit: { ...productKitFixture, sku: "SKU-OTHER" } } }));
  assert.equal(check(result, "kits_exist").pass, false);
});

test("claims: a claim the product kit does not approve fails claims_approved and names it", () => {
  const request = structuredClone(productionRequestFixture);
  request.product = { ...request.product!, claimIds: ["claim_fixture_1", "claim_fixture_9"] };
  const result = checkRequest(fixtureInput({ request }));
  assert.equal(check(result, "claims_approved").pass, false);
  assert.match(check(result, "claims_approved").detail ?? "", /claim_fixture_9/);
});

test("claims: with a product but no product kit, claims cannot be checked and fail", () => {
  const result = checkRequest(fixtureInput({ kits: { ...fixtureInput().kits, productKit: undefined } }));
  assert.equal(check(result, "claims_approved").pass, false);
});

test("speech: the estimate may run to maxMs plus the configured share, and no further", () => {
  assert.equal(thresholds.intake.speechOverrunShare.value, 0.1);
  const maxMs = productionRequestFixture.constraints.maxMs;
  const limit = maxMs * (1 + thresholds.intake.speechOverrunShare.value);
  assert.equal(limit, 33000);
  const atLimit = structuredClone(validatedRequestFixture);
  atLimit.estimatedSpeechMs = limit;
  assert.equal(check(checkRequest(fixtureInput({ validated: atLimit })), "estimated_speech_within_maxMs_plus_10pct").pass, true);
  const over = structuredClone(validatedRequestFixture);
  over.estimatedSpeechMs = limit + 1;
  const failed = check(checkRequest(fixtureInput({ validated: over })), "estimated_speech_within_maxMs_plus_10pct");
  assert.equal(failed.pass, false);
  assert.equal(failed.limit, limit);
});

test("VideoDNA lookup: an unrun lookup fails, and a lookup that disagrees with the validated request fails", () => {
  assert.equal(check(checkRequest(fixtureInput({ dnaLookup: undefined })), "dna_lookup_resolved").pass, false);
  assert.equal(check(checkRequest(fixtureInput({ dnaLookup: "cached" })), "dna_lookup_resolved").pass, false);
  const cached = structuredClone(validatedRequestFixture);
  cached.cachedVideoDnaId = "dna_01KA0000000000000000000000";
  assert.equal(check(checkRequest(fixtureInput({ validated: cached, dnaLookup: "cached" })), "dna_lookup_resolved").pass, true);
  assert.equal(check(checkRequest(fixtureInput({ validated: cached, dnaLookup: "miss" })), "dna_lookup_resolved").pass, false);
});

test("budget: an unknown format minimum fails, and a budget under the minimum fails", () => {
  assert.equal(check(checkRequest(fixtureInput({ formatMinimumUsd: undefined })), "budget_above_format_minimum").pass, false);
  const result = check(checkRequest(fixtureInput({ formatMinimumUsd: 5 })), "budget_above_format_minimum");
  assert.equal(result.pass, false);
  assert.equal(result.value, 4);
  assert.equal(result.limit, 5);
});

test("must: a must with no classification fails every_must_deliverable", () => {
  const result = checkRequest(fixtureInput({ classifications: [] }));
  assert.equal(check(result, "every_must_deliverable").pass, false);
  assert.match(check(result, "every_must_deliverable").detail ?? "", /has no classification/);
});

test("must: a must whose properties no type can deliver fails", () => {
  const classifications = [{ beatId: "b3", want: "the blender on a clean kitchen counter", properties: ["person_talking" as const, "real_product" as const] }];
  const result = checkRequest(fixtureInput({ classifications }));
  assert.equal(check(result, "every_must_deliverable").pass, false);
  assert.match(check(result, "every_must_deliverable").detail ?? "", /no visual type can deliver/);
});

test("must: an empty property list, and a beat the script does not have, both fail", () => {
  const empty = checkRequest(fixtureInput({ classifications: [{ beatId: "b3", want: "the blender on a clean kitchen counter", properties: [] }] }));
  assert.equal(check(empty, "every_must_deliverable").pass, false);
  const request = structuredClone(productionRequestFixture);
  request.visualRequests = [{ beatId: "b99", want: "a thing", strength: "must" }];
  const missingBeat = checkRequest(fixtureInput({ request, classifications: [] }));
  assert.match(check(missingBeat, "every_must_deliverable").detail ?? "", /does not have/);
});

test("policy: a forbidden term from the product kit in the script fails forbidden_terms_absent", () => {
  const request = structuredClone(productionRequestFixture);
  request.script.beats[1] = { ...request.script.beats[1], text: "This blender cures the morning rush." };
  const result = checkRequest(fixtureInput({ request }));
  assert.equal(check(result, "forbidden_terms_absent").pass, false);
  assert.match(check(result, "forbidden_terms_absent").detail ?? "", /cures/);
});

test("a request gate result never names shots, and fails when any single check fails", () => {
  const result = checkRequest(fixtureInput({ formatMinimumUsd: undefined }));
  assert.equal(result.pass, false);
  assert.equal(result.failingShotIds, undefined);
  assert.equal(result.checks.filter((item) => !item.pass).length, 1);
});
