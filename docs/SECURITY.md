# Security

- Every workspace and brand read or write goes through session middleware and a membership check. The client cannot choose the acting user.
- Roles: viewer reads; member edits brands, the brain, products, observations, opportunities, creatives, reviews, and performance; admin or owner manages people, deletion, rename, and scoring weights. The last owner cannot be removed.
- Brand ids are resolved to an organization on the server. Ranking and learning throw if a row from another brand is passed in.
- Public page fetch allows only http(s), blocks local and metadata hostnames, resolves DNS, and blocks private, link-local, and loopback addresses. Redirects are followed manually and checked again. Bodies are capped.
- Page text and competitor copy are stored as data. Prompts wrap them in `untrusted_source` and tell the model not to follow instructions inside.
- Website fields on the brand and competitor are validated as http(s) and are not fetched by themselves.
- Invites are not email. The UI says delivery is not configured.
- Secrets are not committed. `OPENROUTER_API_KEY` and optional `GOOGLE_AI_STUDIO_API_KEY` are read only in server modules. Model logs do not include the keys.
- Generated JSON is validated before a creative row is written. Claim checks run after generation, not instead of it.
- Audit rows record workspace, brand, brain, product, membership, weight, observation, opportunity, review, performance, and learning changes. JEV rows record the decision itself.
