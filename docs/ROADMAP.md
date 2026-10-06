# Roadmap

In this tree:

1. Accounts, workspaces, roles, brands, Brand Brain, products, audit.
2. Manual observations, public-page fetch, competitor candidates that stay candidates until confirmed.
3. JEV questions, thresholds, persisted decisions, review.
4. Opportunities and briefs from stored evidence, including learned patterns.
5. Text production when a model key exists, otherwise a human script.
6. Text guardian. Logo search on PNG bytes. Missing vision stays in human review.
7. Manual performance and a provider performance gate that rejects bad rows.
8. A separate worker and a scheduler that only enqueues.
9. Provider clients for Meta, TikTok, Google Ads, and Ad Library. They publish or list only after a real response. Approved Hypit MP4s use the Meta client to create a paused video-ad chain with upload reconciliation. See [PROVIDERS.md](PROVIDERS.md).
10. Filesystem and S3-compatible object storage clients.
11. Local semantic embeddings. An external embedding vendor stays not connected without a key.

External launch dependencies:

- A customer ad account and the permission to spend.
- A verified S3 bucket in this environment.
- The separate Hypit video runtime and a reachable `HYPIT_BASE_URL`.
- An always-on worker on serverless hosting.
- A hosted OAuth consent screen. Tokens are supplied by the host.
- A full WCAG 2.2 AA certification. See [ACCESSIBILITY.md](ACCESSIBILITY.md).

Learning updates knowledge. It does not rewrite application source.
