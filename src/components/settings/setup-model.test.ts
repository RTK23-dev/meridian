import assert from "node:assert/strict";
import test from "node:test";
import { CREDENTIAL_VAULT_TYPE, SHARED_DEFAULT_ENV, type CredentialCategory } from "../../lib/meridian/credentials/contract.ts";
import {
  rowsIn,
  setupCounts,
  setupHeadline,
  setupRows,
  SETUP_GROUPS,
  type SetupEngines,
  type SetupRow,
} from "./setup-model.ts";

const KEYED = Object.keys(CREDENTIAL_VAULT_TYPE) as CredentialCategory[];

type Summary = {
  category: string;
  configured: boolean;
  source: "workspace" | "deployment" | "default" | "not_configured";
  credentialState?: "usable" | "unusable" | "not_configured";
  credentialReason?: string;
  keyFingerprint?: string;
  settings: Record<string, unknown>;
  capabilities: string[];
};

/** A summary for every category, as the server returns them. Every keyed category starts not configured. */
function summaries(overrides: Record<string, Partial<Summary>> = {}): Parameters<typeof setupRows>[0]["summaries"] {
  const base: Record<string, Summary> = {};
  for (const category of KEYED) {
    const shared = SHARED_DEFAULT_ENV[category];
    base[category] = {
      category,
      configured: false,
      source: "not_configured",
      credentialState: "not_configured",
      credentialReason: `This workspace has no saved key, and the deployment does not share one. Set ${shared.variable}=${shared.accepts} to use the deployment key.`,
      settings: category === "hypit" ? { baseUrlConfigured: true } : {},
      capabilities: [],
    };
  }
  base.jev = { ...base.jev, credentialReason: "This workspace has no saved key. Set JEV_SHARED_DEFAULT=deployment to use the deployment key." };
  base.perception = { ...base.perception, settings: {} };
  base.sources = { category: "sources", configured: true, source: "default", settings: { maxPagesPerRun: 50 }, capabilities: [] };
  base.cyclone = { category: "cyclone", configured: false, source: "default", settings: {}, capabilities: [] };
  base.storage = {
    category: "storage",
    configured: false,
    source: "default",
    settings: { driveDetail: "Neither GOOGLE_SERVICE_ACCOUNT_KEY nor GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN is set. Google Drive is not connected." },
    capabilities: [],
  };
  for (const [category, patch] of Object.entries(overrides)) {
    base[category] = { ...base[category], ...patch } as Summary;
  }
  return base as unknown as Parameters<typeof setupRows>[0]["summaries"];
}

const READY_ENGINES: SetupEngines = {
  active: { engineId: "jev", source: "default" },
  engines: [
    { id: "jev", label: "TypeSafe JEV", health: { status: "READY", message: "JEV via TypeSafe. Credentials present. No live request has been made." } },
    { id: "openai-decisions", label: "OpenAI Decisions", health: { status: "NOT_CONFIGURED", message: "No OpenAI key is saved for this workspace." } },
  ],
};

function rowOf(rows: SetupRow[], id: string): SetupRow {
  const row = rows.find((item) => item.id === id);
  assert.ok(row, `a row for ${id}`);
  return row;
}

test("the view lists every keyed category once, the decision engine, and Google Drive", () => {
  const rows = setupRows({ summaries: summaries(), engines: READY_ENGINES });
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "no row is listed twice");
  for (const category of KEYED) assert.ok(ids.includes(category), `${category} has a row`);
  assert.ok(ids.includes("decision_engine"));
  assert.ok(ids.includes("google_drive"));
  assert.equal(rows.length, KEYED.length + 2);
});

test("a usable workspace key is usable, shows its fingerprint, and offers a form and removal", () => {
  const rows = setupRows({
    summaries: summaries({ jev: { configured: true, source: "workspace", credentialState: "usable", keyFingerprint: "...1234", credentialReason: undefined } }),
    engines: READY_ENGINES,
  });
  const jev = rowOf(rows, "jev");
  assert.equal(jev.status, "usable");
  assert.equal(jev.fingerprint, "...1234");
  assert.match(jev.reason, /workspace's own saved key/);
  assert.deepEqual(jev.save, { kind: "form", category: "jev" });
  assert.equal(jev.removable, true);
});

test("a deployment key used through the shared default is listed as a deployment shared default, and names the variable", () => {
  const rows = setupRows({
    summaries: summaries({ openai: { configured: true, source: "deployment", credentialState: "usable", keyFingerprint: "...9876", credentialReason: undefined } }),
    engines: READY_ENGINES,
  });
  const openai = rowOf(rows, "openai");
  assert.equal(openai.status, "deployment_shared_default");
  assert.match(openai.reason, /OPENAI_SHARED_DEFAULT=deployment is set/);
  assert.equal(openai.fingerprint, "...9876", "the masked fingerprint of the key in use");
  assert.equal(openai.removable, false, "a deployment key is not removed from the panel");
});

test("a saved key that cannot be used is unusable, says why, and can be removed", () => {
  const rows = setupRows({
    summaries: summaries({
      meta_ad_library: {
        configured: false,
        source: "workspace",
        credentialState: "unusable",
        credentialReason: "The workspace's saved Meta Ad Library credential has expired. Save a new key in the settings.",
      },
    }),
    engines: READY_ENGINES,
  });
  const meta = rowOf(rows, "meta_ad_library");
  assert.equal(meta.status, "unusable");
  assert.match(meta.reason, /has expired/);
  assert.equal(meta.fingerprint, null, "no fingerprint for an unusable entry");
  assert.equal(meta.removable, true);
});

test("with no saved key and no shared default, the row is not configured and names the variable that would share one", () => {
  const rows = setupRows({ summaries: summaries(), engines: READY_ENGINES });
  const production = rowOf(rows, "production");
  assert.equal(production.status, "not_configured");
  assert.match(production.reason, /PRODUCTION_SHARED_DEFAULT=deployment/);
  assert.equal(production.fingerprint, null);
  assert.equal(production.removable, false);
});

test("Hypit needs its base URL: without HYPIT_BASE_URL the row is not configured, and a saved key is kept and named", () => {
  const withKey = setupRows({
    summaries: summaries({
      hypit: { configured: true, source: "workspace", credentialState: "usable", keyFingerprint: "...4321", settings: { baseUrlConfigured: false } },
    }),
    engines: READY_ENGINES,
  });
  const hypit = rowOf(withKey, "hypit");
  assert.equal(hypit.status, "not_configured");
  assert.match(hypit.reason, /HYPIT_BASE_URL is not set/);
  assert.match(hypit.note ?? "", /saved key is kept/);
  assert.deepEqual(hypit.save, { kind: "form", category: "hypit" }, "the key can still be saved from the row");

  const configured = setupRows({
    summaries: summaries({
      hypit: { configured: true, source: "workspace", credentialState: "usable", keyFingerprint: "...4321", settings: { baseUrlConfigured: true } },
    }),
    engines: READY_ENGINES,
  });
  assert.equal(rowOf(configured, "hypit").status, "usable");
});

test("the decision engine row reports the active engine's health, the source of the choice, and an invalid deployment value", () => {
  const ready = rowOf(setupRows({ summaries: summaries(), engines: READY_ENGINES }), "decision_engine");
  assert.equal(ready.status, "usable");
  assert.match(ready.reason, /TypeSafe JEV receives this workspace's decisions/);
  assert.equal(ready.save.kind, "engine", "the choice is saved by the decision engine card, not by this row");

  const openai = rowOf(
    setupRows({
      summaries: summaries(),
      engines: {
        active: { engineId: "openai-decisions", source: "workspace" },
        engines: [
          { id: "jev", label: "TypeSafe JEV", health: { status: "NOT_CONFIGURED", message: "No TypeSafe key is saved." } },
          { id: "openai-decisions", label: "OpenAI Decisions", health: { status: "NOT_CONFIGURED", message: "No OpenAI key is saved for this workspace." } },
        ],
      },
    }),
    "decision_engine",
  );
  assert.equal(openai.status, "not_configured");
  assert.match(openai.reason, /chosen for this workspace/);
  assert.match(openai.reason, /cannot answer decisions yet/);
  assert.doesNotMatch(openai.reason, /receives this workspace's decisions/, "a not-ready engine is never described as receiving decisions");

  const degraded = rowOf(
    setupRows({
      summaries: summaries(),
      engines: { active: { engineId: "jev", source: "deployment" }, engines: [{ id: "jev", label: "TypeSafe JEV", health: { status: "DEGRADED", message: "TypeSafe did not answer the check." } }] },
    }),
    "decision_engine",
  );
  assert.equal(degraded.status, "unusable");
  assert.match(degraded.reason, /DECISION_ENGINE/);

  const invalid = rowOf(
    setupRows({
      summaries: summaries(),
      engines: { active: { engineId: "jev", source: "default", invalidDeploymentValue: "nope" }, engines: READY_ENGINES.engines },
    }),
    "decision_engine",
  );
  assert.match(invalid.note ?? "", /DECISION_ENGINE is set to "nope"/);
});

test("Google Drive is a deployment row with no key form, and names the variables that connect it", () => {
  const off = rowOf(setupRows({ summaries: summaries(), engines: READY_ENGINES }), "google_drive");
  assert.equal(off.status, "not_configured");
  assert.match(off.reason, /filesystem fallback/);
  assert.equal(off.save.kind, "deployment");
  assert.ok(off.save.kind === "deployment" && off.save.variables.includes("GOOGLE_SERVICE_ACCOUNT_KEY"));

  const on = rowOf(
    setupRows({
      summaries: summaries({
        storage: { configured: true, source: "deployment", settings: { driveDetail: "Google Service Account key is configured." } },
      }),
      engines: READY_ENGINES,
    }),
    "google_drive",
  );
  assert.equal(on.status, "deployment_shared_default");
  assert.match(on.reason, /shares these credentials with every workspace/);
});

test("only keyed rows save through a form, and every form names a category the save path accepts", () => {
  const rows = setupRows({ summaries: summaries(), engines: READY_ENGINES });
  for (const row of rows) {
    if (row.save.kind === "form") {
      assert.ok(row.save.category in CREDENTIAL_VAULT_TYPE, `${row.id} saves a keyed category`);
      assert.equal(row.id, row.save.category);
    }
  }
  assert.equal(rowOf(rows, "decision_engine").save.kind, "engine");
  assert.equal(rowOf(rows, "google_drive").save.kind, "deployment");
});

test("every row belongs to a listed group, and the groups hold the rows the view names", () => {
  const rows = setupRows({ summaries: summaries(), engines: READY_ENGINES });
  const groupIds = new Set(SETUP_GROUPS.map((group) => group.id));
  for (const row of rows) assert.ok(groupIds.has(row.group), `${row.id} is in a group`);
  assert.deepEqual(rowsIn(rows, "decisions").map((row) => row.id), ["decision_engine", "jev", "openai"]);
  assert.deepEqual(rowsIn(rows, "media").map((row) => row.id), ["perception", "production", "hypit"]);
  assert.deepEqual(rowsIn(rows, "sources").map((row) => row.id), ["meta_ad_library"]);
  assert.equal(rowsIn(rows, "other_sources").length, KEYED.length - 6, "every other source connector is listed");
  assert.deepEqual(rowsIn(rows, "storage").map((row) => row.id), ["google_drive"]);
});

test("fingerprints are masked, and the rows never carry a key", () => {
  const rows = setupRows({
    summaries: summaries({
      search: { configured: true, source: "workspace", credentialState: "usable", keyFingerprint: "...abcd", credentialReason: undefined },
    }),
    engines: READY_ENGINES,
  });
  for (const row of rows) {
    if (row.fingerprint !== null) assert.match(row.fingerprint, /^\.\.\.[^.]{4}$/, `${row.id}: masked`);
  }
  assert.equal(JSON.stringify(rows).includes("sk-"), false);
});

test("the counts and the headline state counts only, and never claim a live provider was reached", () => {
  const rows = setupRows({
    summaries: summaries({
      jev: { configured: true, source: "workspace", credentialState: "usable", keyFingerprint: "...1111" },
      openai: { configured: true, source: "deployment", credentialState: "usable", keyFingerprint: "...2222" },
      meta_ad_library: { configured: false, source: "workspace", credentialState: "unusable", credentialReason: "It has expired." },
    }),
    engines: READY_ENGINES,
  });
  const counts = setupCounts(rows);
  assert.equal(counts.usable, 2, "the engine and JEV");
  assert.equal(counts.deployment_shared_default, 1, "OpenAI through the shared default");
  assert.equal(counts.unusable, 1);
  assert.equal(counts.total, rows.length);
  const headline = setupHeadline(rows);
  assert.match(headline, /2 usable/);
  assert.match(headline, /Nothing is checked against a live provider here\./);
});
