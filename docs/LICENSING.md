# Licensing

This repository is original code under the MIT License (`LICENSE`, copyright 2026 RTK).

No Hypit, JEV, or other advertising-product source is included. Workflow stages and a typed decision gate are independent implementations of the product idea. Third-party packages stay under their own licenses. They were not relicensed.

Direct dependencies, from each package's `license` field:

| Dependency | License | Usage |
| --- | --- | --- |
| React, React DOM, TanStack Start / Router / Query / Table | MIT | Application framework |
| Vite, Nitro, Tailwind, Radix, Better Auth, Zod, Kysely, pg, Zustand, Lucide, Recharts, and the other MIT rows in `package.json` | MIT | UI, auth, database, utilities |
| `@electric-sql/pglite` | Apache-2.0 | Embedded Postgres for preview |
| `class-variance-authority`, `typescript`, `playwright` | Apache-2.0 | Styling helpers, types, browser checks |
| `lightningcss` | MPL-2.0 | CSS transform used by Tailwind. Used unmodified as a dependency. MPL obligations apply to that package's files, not to this application's source |
| `lucide-react` | ISC | Icons |

Allowed usage for the MIT and Apache-2.0 packages is the ordinary dependency use those licenses grant. Restrictions that matter here:

- Keep their copyright notices if we redistribute those packages. `npm` already does that in `node_modules` and the lockfile. We do not copy their source into `src/`.
- MPL-2.0 on Lightning CSS: modifications to Lightning CSS itself would need to stay under MPL. We have not modified it.
- Nothing in this list grants the right to copy a proprietary ad platform, a closed model, or another product's source.

Provider calls go to xAI or OpenRouter under those vendors' API terms when a key is configured. That is not a source dependency.

`package.json` is the inventory. Re-read a package's `license` field before adding another one.
