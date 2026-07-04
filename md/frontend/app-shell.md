# App Shell — entries, routing, nav, and the dual index/worker build

**Source:** `src/App.jsx`, `src/WorkerApp.jsx`, `src/main.jsx`, `src/worker-main.jsx`, `index.html`, `worker.html`, `vite.config.js`, `vercel.json`
**Read this when:** adding/renaming a route or sidebar item, changing which pages hide the sidebar, touching the worker entry/basename, debugging "route works locally but 404s deployed" (or vice versa), or changing the Vite build inputs/base path.

## What it does
Two independent HTML entries are built by Vite: `index.html` → `src/main.jsx` → `App` (the "Command Center" admin SPA with sidebar) and `worker.html` → `src/worker-main.jsx` → `WorkerApp` (a standalone Worker Portal SPA with its own `BrowserRouter` basename). `App` owns all internal routing via `react-router-dom` `BrowserRouter`; `AppShell` hides the sidebar for the three "standalone" portal paths (`/hhh-login`, `/pg-login`, `/worker`). Deployment rewrites in `vercel.json` route `/worker` to `worker.html` and everything else (except `api/`, `assets/`, and extension-bearing paths) to `index.html`.

## Key functions / exports
| name | signature | behavior | called by |
|---|---|---|---|
| `App` (default, `src/App.jsx`) | `() -> JSX` | Wraps `AppShell` in `BrowserRouter` | `src/main.jsx` |
| `AppShell` (`src/App.jsx`, private) | `() -> JSX` | Computes `standalone` from `useLocation().pathname` prefix (`/hhh-login`, `/pg-login`, `/worker`); renders `Sidebar` unless standalone; owns the `<Routes>` table | `App` |
| `Sidebar` (`src/App.jsx`, private) | `() -> JSX` | Violet "Command Center" nav; `navItem(to, icon, label, end)` builds `NavLink`s; footer link opens `/worker` in a new tab (`target="_blank"`) | `AppShell` |
| `WorkerApp` (default, `src/WorkerApp.jsx`) | `() -> JSX` | `BrowserRouter` with computed `basename`; `/` → `WorkerPortal`, `*` → redirect `/` | `src/worker-main.jsx` |
| `resolveBasename` (`src/WorkerApp.jsx`, private) | `() -> string` | If `import.meta.env.BASE_URL !== '/'` (GitHub Pages) → `${base}worker.html`; else `/worker.html` when the page loaded from the raw file, else `/worker` | module init (once) |

## Data shapes
Route table in `AppShell` (all element components are page defaults):
```
/                  -> Navigate /builder/workflows (replace)
/builder/workflows -> WorkflowList        (src/pages/builder/WorkflowList.jsx)
/builder/create    -> Navigate /builder/workflows (legacy redirect)
/orchestrator      -> Orchestrator        (src/pages/orchestrator/Orchestrator.jsx)
/map               -> NetworkMap          (src/pages/map/NetworkMap.jsx)
/employees         -> Employees           (src/pages/employees/Employees.jsx)
/entity            -> Entity              (src/pages/entity/Entity.jsx)
/external-users    -> ExternalUsers       (src/pages/external/ExternalUsers.jsx)
/worker            -> WorkerPortal        (src/pages/worker/WorkerPortal.jsx)  // dev-only fallback, see gotchas
/hhh-login         -> HhhLogin            (src/pages/hhh/HhhLogin.jsx)
/pg-login          -> PgLogin             (src/pages/pg/PgLogin.jsx)
*                  -> Navigate /builder/workflows
```
Sidebar nav items (all `end` matching): Workflow → `/builder/workflows`, Orchestrator, Coverage Map → `/map`, Employees, Entity, External Users. `/hhh-login` and `/pg-login` have NO sidebar entry — they are reached by direct URL.

`vercel.json` rewrites (order matters):
```json
{ "source": "/worker",        "destination": "/worker.html" }
{ "source": "/worker/(.*)",   "destination": "/worker.html" }
{ "source": "/((?!api/|assets/|.*\\.\\w+$).*)", "destination": "/index.html" }
```

`vite.config.js`: `base = DEPLOY_TARGET === 'pages' ? '/workflow-poc/' : '/'`; `build.rollupOptions.input = { main: index.html, worker: worker.html }`.

## Invariants & gotchas
- **`/worker` is served by two different apps depending on host.** On Vercel the rewrite wins, so `/worker` loads `worker.html` → `WorkerApp` (standalone). In `vite dev` there are no rewrites, so `/worker` falls into `index.html` → `App`'s `/worker` route — that route exists precisely for local dev. Keep both in sync when changing the worker page.
- **Worker basename must match the actual URL** or react-router silently renders nothing. `resolveBasename` handles three cases (Pages `/workflow-poc/worker.html`, Vercel clean `/worker`, raw `/worker.html`). If you add worker sub-routes, `vercel.json` already rewrites `/worker/(.*)`.
- The SPA catch-all regex excludes any path containing a file extension (`.*\.\w+$`), so deep links like `/foo.bar` 404 on Vercel rather than loading the SPA — intentional (protects real static assets).
- `standalone` uses `startsWith`, so any future route beginning with those prefixes also hides the sidebar.
- Both entries import `src/index.css` (Tailwind); `App.css` exists but is not imported by the entries.
- GitHub Pages build (`DEPLOY_TARGET=pages`) changes `BASE_URL`, so absolute asset URLs in `index.html`/`worker.html` (`/favicon.svg`, `/src/main.jsx`) are rewritten by Vite at build time — don't hardcode extra absolute paths in JSX.

## Change recipes
1. **Add an admin page:** create `src/pages/<area>/<Page>.jsx`, add a `<Route>` in `AppShell` and a `navItem(...)` in `Sidebar` (`src/App.jsx`). No vercel.json change needed (catch-all covers it).
2. **Add a standalone (no-sidebar) portal:** add the route in `AppShell` AND add its path prefix to the `standalone` check in `AppShell`.
3. **Add a third HTML entry:** create `<name>.html` + `src/<name>-main.jsx`, register it in `vite.config.js` `build.rollupOptions.input`, add a rewrite in `vercel.json` before the catch-all, and mirror the `WorkerApp` basename logic if it uses a router.
4. **Change worker routing:** edit `src/WorkerApp.jsx` routes; if adding paths, verify `resolveBasename` still matches how the page is loaded on each host and keep the dev-only `/worker` route in `App.jsx` consistent.

## Related
- [pages/worker](pages/worker.md) — WorkerPortal/WorkerTaskDetail rendered by both entries.
- [pages/portals](pages/portals.md) — the standalone `/hhh-login` and `/pg-login` pages.
- [pages/builder](pages/builder.md) — default landing route content.
- [lib](lib.md) — API clients every routed page uses.
- [ops/scripts-and-deploy](../ops/scripts-and-deploy.md) — build commands, Vercel + Pages deploys.
