export type AngleCluster = { key: string; count: number };
export type SemanticCluster = { label: string; summary: string };

/**
 * Clusters as cards. Angle fingerprints carry a stored member count. Semantic clusters do not, so they say so
 * instead of showing a number that is not there.
 */
export function ClusterCards({ angleClusters, semanticClusters }: { angleClusters: AngleCluster[]; semanticClusters: SemanticCluster[] }) {
  return <div className="space-y-6">
    <section aria-labelledby="angle-fingerprints" className="space-y-3">
      <h3 id="angle-fingerprints" className="font-display text-base font-semibold">Angle fingerprints</h3>
      {angleClusters.length === 0 ? <p className="text-sm text-fg-muted">No angle fingerprints are stored yet.</p> : <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {angleClusters.map((group) => <li key={group.key} className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Fingerprint</p>
          <p className="mt-1 font-display text-lg capitalize">{group.key.replace(/_/g, " ")}</p>
          <p className="mt-2 text-sm"><span className="font-semibold tabular-nums">{group.count}</span> {group.count === 1 ? "member" : "members"}</p>
        </li>)}
      </ul>}
    </section>
    <section aria-labelledby="semantic-clusters" className="space-y-3">
      <h3 id="semantic-clusters" className="font-display text-base font-semibold">Semantic clusters</h3>
      {semanticClusters.length === 0 ? <p className="text-sm text-fg-muted">No semantic clusters are stored yet.</p> : <>
        <p className="text-xs text-fg-muted">The server does not return member counts for semantic clusters yet.</p>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {semanticClusters.map((group, index) => <li key={`${group.label}:${index}`} className="rounded-lg border border-border bg-surface p-4">
            <p className="font-display text-lg">{group.label}</p>
            <p className="mt-2 text-sm text-fg-muted">{group.summary}</p>
          </li>)}
        </ul>
      </>}
    </section>
  </div>;
}
