// The cookbook selector's port through the engine's role runner, with recorded answers (K10, Q34). One call per proposal; a recorded answer
// becomes a proposal with its values; an answer that breaks the contract is a failure, never a pick; a gateway without its key gives the picker.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deps, fixture, gatewayFor, json, ledgerWith, RESERVATION_ID, REQUEST_ID, WORKSPACE } from "../../../engine/claude/test/helpers.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import type { RunInputs } from "./eligibility.ts";
import { cookbookSelectorPort } from "./selector-port.ts";
import { proposeCookbooks } from "./selector.ts";

const INPUTS: RunInputs = {
  briefChars: 240,
  reference: { attached: false, dnaCached: false },
  productKit: false,
  uploads: { voice: false, footage: false, music: false },
  budgetUsd: 2,
  runKind: "normal",
};

const SCOPE = { requestId: REQUEST_ID, workspaceId: WORKSPACE, reservationId: RESERVATION_ID };

const notAnAnswer = {
  id: "gen-not-json",
  model: "anthropic/claude-haiku-5.5",
  object: "chat.completion",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Here is my choice: the explainer." } }],
  usage: { prompt_tokens: 1800, completion_tokens: 12, total_tokens: 1812, cost: 0.0019 },
};

test("a recorded answer becomes a proposal with its values, through one paid call on the ledger", async () => {
  const ledger = await ledgerWith(1);
  const { gateway, requests } = gatewayFor([json(200, fixture("openrouter-cookbook-selector-ok"))]);
  const port = cookbookSelectorPort({ deps: deps(gateway, ledger), ...SCOPE });

  const proposal = await proposeCookbooks({ cookbooks: [threeDDataExplainerCookbook], inputs: INPUTS, lengthMs: 60000, port });
  assert.equal(proposal.status, "proposed");
  if (proposal.status !== "proposed") return;
  assert.equal(proposal.picks[0]?.cookbookId, "ck_3d_data_explainer");
  assert.equal(proposal.picks[0]?.values.pace, 1.2);
  assert.equal(requests.length, 1, "one call for one proposal");
});

test("an answer that is not the contract's shape is a failure, not a pick", async () => {
  const ledger = await ledgerWith(1);
  const { gateway } = gatewayFor([json(200, notAnAnswer), json(200, notAnAnswer)]);
  const port = cookbookSelectorPort({ deps: deps(gateway, ledger), ...SCOPE });

  const proposal = await proposeCookbooks({ cookbooks: [threeDDataExplainerCookbook], inputs: INPUTS, lengthMs: 60000, port });
  assert.notEqual(proposal.status, "proposed", "nothing is picked from an answer that breaks the contract");
  assert.equal(proposal.status, "failed");
});

test("a provider without its key gives the picker, with the eligible cookbooks, and no call is made", async () => {
  const ledger = await ledgerWith(1);
  const { gateway, requests } = gatewayFor([], { keys: {} });
  const port = cookbookSelectorPort({ deps: deps(gateway, ledger), ...SCOPE });

  const proposal = await proposeCookbooks({ cookbooks: [threeDDataExplainerCookbook], inputs: INPUTS, lengthMs: 60000, port });
  assert.equal(proposal.status, "not_connected");
  assert.equal(requests.length, 0, "no paid call without a key");
});
