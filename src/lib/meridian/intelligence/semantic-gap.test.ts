// Two clusters can carry the same label: a cluster's label is its most common angle, so two clusters around "offer" are two findings
// with one underused label. The studio lists key on the finding id, so the two findings must keep distinct ids.

import assert from "node:assert/strict";
import test from "node:test";
import { whitespaceFromClusters } from "./semantic-gap.ts";
import type { MarketCluster } from "./whitespace.ts";

function cluster(id: string, label: string, competitorCount: number): MarketCluster {
  return {
    id,
    label,
    memberIds: [`${id}:a`, `${id}:b`],
    competitorCount,
    ownCount: 0,
    summary: `${competitorCount} creatives around ${label}.`,
  };
}

test("two clusters with the same label give two findings with distinct ids", () => {
  const clusters = [cluster("cluster-1", "offer", 3), cluster("cluster-2", "offer", 2)];
  const findings = whitespaceFromClusters({ clusters, brandText: "A fair offer for every household" });
  assert.equal(findings.length, 2, "each cluster is its own finding, even with a repeated label");
  assert.deepEqual(findings.map((finding) => finding.underused), ["offer", "offer"]);
  assert.deepEqual(findings.map((finding) => finding.id), ["cluster-1", "cluster-2"], "the id is unique per cluster, so a list can key on it");
});
