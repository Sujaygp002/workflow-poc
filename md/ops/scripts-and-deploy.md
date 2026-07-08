# Ops — npm scripts, DB scripts, deploy, env & credentials

**Source:** `package.json`, `scripts/migrate.js`, `scripts/seed.js`, `scripts/wipe.js`, `scripts/seed-map-demo.js`, `scripts/totp.js`, `vite.config.js`, `vercel.json`, `api/_lib/config.js`
**Read this when:** running/adding an npm or DB script, changing deploy behavior, understanding env/credentials, or the 12-serverless-function cap.

## npm scripts (package.json)
| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (frontend only — `/api/*` needs the Vercel runtime + DB) |
| `npm run build` | Production build (verify changes compile — builds BOTH `index.html` and `worker.html` entries) |
| `npm run lint` | ESLint over the repo |
| `npm run db:migrate` | Apply Neon migrations idempotently (`scripts/migrate.js`) |
| `npm run db:reset` | Drop + recreate the public schema, then re-migrate (`migrate.js --reset`) |
| `npm run db:seed` | Seed workflow definitions + demo data (`scripts/seed.js`) |
| `npm run db:wipe` | TRUNCATE all data tables, keep schema (`scripts/wipe.js`) |
| `npm run preview` | Serve the built `dist/` locally |

## DB scripts (scripts/)
- **`migrate.js`** — applies each `db/migrations/*.sql` once (tracked in `schema_migrations`); `--reset` drops/recreates the public schema first.
- **`wipe.js`** — one `TRUNCATE … CASCADE` over every data table (patients, orders, runs, entities, employees, external users, workflows, sessions, area tables…), keeping the schema and `schema_migrations`. Prints before/after row counts. System workflow definitions re-appear on demand via `ensureSystemDefinitions()` (called by `GET /api/workflows` and the upload route).
- **`seed.js`** — upserts workflow definitions + optional demo domain data.
- **`seed-map-demo.js`** — additive Coverage-Map demo network (agencies/PGs/practitioners/patients/orders).
- **`totp.js`** — `node scripts/totp.js <BASE32_SECRET>` prints the current 6-digit TOTP code (test/QA helper; worker login is single-factor so this is only useful for manual TOTP testing via the legacy `totpCode` helper in `api/_lib/auth.js`).

## Deploy
- **Vercel**: pushing to `main` on the GitHub repo auto-deploys production at `workflow-poc-tawny.vercel.app`. `vercel.json` rewrites `/worker`→`worker.html` and the SPA catch-all →`index.html` (excludes `api/`, `assets/`, extension paths).
- **GitHub Pages** (optional): `DEPLOY_TARGET=pages npm run build` sets Vite `base=/workflow-poc/` (frontend-only; no API).
- **Serverless-function cap**: Vercel Hobby allows **12 functions** and `api/` is currently at exactly 12. Adding capability = add a POST `action` to an existing handler (the pattern in `orders`/`workflow-runs`/`workflows`/`reference-data`/`auth`), NOT a new `api/*` file. If you must add a file, delete/merge another.

## Env & credentials (api/_lib/config.js)
Every credential is `export const X = process.env.X || '<hardcoded fallback>'` — the app runs with zero env vars (personal-test convenience); Vercel env vars override.
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection (serverless HTTP driver) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | AI PDF extraction (`gemini-2.5-flash`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (order PDFs; skips gracefully if absent) |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | Outbound email (best-effort; Gmail app password) |

## Invariants & gotchas
- **The committed fallbacks are LIVE secrets** (Neon, Gemini, Blob, a real Gmail app password) in public git history — rotate before any real use. Do not move them elsewhere without asking (project convention).
- `npm run dev` cannot exercise `/api/*` — those are Vercel serverless functions needing the runtime + DB. Verify backend changes with `npm run build` + lint, then against the deployed app (or a local shim that mounts the `api/` handlers against the live DB, as used in testing).
- `db:wipe` is destructive and immediate (no confirm) — it's the intended "fresh start" and is what the demo/QA flows run before recording. It does NOT drop the schema (that's `db:reset`).
- Migrations are additive and idempotent (`IF NOT EXISTS`); `db:migrate` is safe to re-run. Keep new migrations additive so deployed code survives the migrate→deploy gap.
- Two Vite entries (`index.html`, `worker.html`) — both build from `rollupOptions.input`; a new HTML entry must be registered there + in `vercel.json` (see [app shell](../frontend/app-shell.md)).

## Change recipes
1. **Add an npm script:** add it to `package.json` `scripts`; if it's a node script, drop it in `scripts/`.
2. **Add a migration:** create `db/migrations/00N_*.sql` (additive), run `npm run db:migrate`; document tables in [schema](../db/schema.md).
3. **Add backend capability without a new function file:** add a POST `action` case to the closest existing route (see the route docs) — respects the 12-function cap.
4. **Add/rotate a credential:** edit `api/_lib/config.js` (env-or-fallback) + set the Vercel env var; see [utils](../backend/lib/utils.md).
5. **Change deploy routing:** edit `vercel.json` rewrites (order matters — specific before the catch-all) and/or `vite.config.js` base/inputs.

## Related
- [db schema](../db/schema.md) — what `db:migrate`/`db:wipe` operate on
- [utils/config](../backend/lib/utils.md) — the config module + Neon client
- [app shell](../frontend/app-shell.md) — Vite entries + vercel rewrites
- [auth primitives](../backend/lib/auth.md) — `scripts/totp.js` uses `totpCode`
- [main index](../main.md) — the 12-function cap + additive-migration rules for AI sessions
