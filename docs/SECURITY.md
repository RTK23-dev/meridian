# Security

- Every workspace and brand read or write goes through session middleware and a membership check. The client cannot choose the acting user.
- Roles: viewer reads; member edits brands, the brain, and products; admin or owner manages people, deletion, rename, and scoring weights. The last owner cannot be removed.
- Brand ids are resolved to an organization on the server. A member of another workspace receives “not available” or “not found.”
- Website fields are validated as http(s) URLs and stored. They are not fetched, so this version has no server-side request to a user-supplied host.
- Invites are not email. The UI says delivery is not configured.
- Secrets are not committed. Deployed auth and `DATABASE_URL` are injected by the host. Do not add a `.env` file to this workspace.
- Audit rows record who changed a workspace, brand, brain, product, membership, or weight set.
- Uploaded or scraped text, when ingestion exists, must be stored as data and must not be concatenated into privileged instructions.
