# Auth Primitives — scrypt password hashing, TOTP helpers (legacy), bearer sessions
**Source:** `api/_lib/auth.js`
**Read this when:** changing password rules, session TTLs, bearer-token parsing, or adding auth guards to a route.

## What it does
Dependency-free (node:crypto only) auth toolkit for the Command Center. Three concerns:
1. **Passwords** — scrypt hashing into a self-describing `s2$N$r$p$saltB64$hashB64` string, constant-time verify.
2. **TOTP helpers (legacy/unused by login)** — RFC 6238 (HMAC-SHA1, 6 digits, 30 s period, ±1 window skew) plus base32 encode/decode and `otpauth://` URL. These functions exist in the file but are **not called by the worker login flow**, which is single-factor password only.
3. **Sessions** — random bearer tokens whose **sha256 hash only** is stored in `auth_sessions` (via `identityRepo.js`). Sessions are issued at the `complete` stage (12 h). `requireSession` is the guard every protected route calls.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `hashPassword` | `(password) -> 's2$…' string` | scrypt-hash with fresh 16-byte salt; **throws httpError(400) if <8 chars** (doubles as validation) | `api/auth/index.js` create/update employee + external user |
| `verifyPassword` | `(password, stored) -> boolean` | parses N/r/p/salt from stored string, scrypt + `timingSafeEqual`; returns false (never throws) on any malformed input | `workerLogin`, `externalLogin` in `api/auth/index.js` |
| `generateTotpSecret` | `() -> base32 string` | base32 of 20 random bytes | `createEmployee` in `api/auth/index.js` (secret stored; **not used by login**) |
| `totpCode` | `(secretB32, timestampMs=now) -> '123456'` | current 6-digit code for the 30 s counter | `scripts/totp.js` test helper only — **legacy, unused by login** |
| `verifyTotp` | `(secretB32, code, timestampMs=now) -> boolean` | requires exactly `/^\d{6}$/`; accepts counter skew −1/0/+1 (~90 s validity); constant-time compare | **legacy/unused by login** — worker login is single-factor password |
| `otpauthUrl` | `(username, secretB32) -> string` | `otpauth://totp/CommandCenter:<user>?...&issuer=CommandCenter` for QR enrollment | **exported but not called anywhere** — legacy, kept for future QR enrollment use |
| `base32Encode` / `base32Decode` | `(Buffer)->string` / `(string)->Buffer` | RFC 4648, no padding; decode strips non-alphabet chars and uppercases | internal to TOTP helpers; exported |
| `httpError` | `(status, message, details=null) -> Error` | Error with `.status` (+`.details`) that `http.js handleError` maps straight to the HTTP response | throughout `api/` routes |
| `hashToken` | `(token) -> sha256 hex` | how raw bearer tokens map to `auth_sessions.token_hash` | `createSessionFor`, `requireSession`, `destroySession` |
| `createSessionFor` | `({principalType, principalId, stage='complete', meta={}}) -> {token, session}` | mints 32-byte base64url token, stores only its hash with stage-appropriate TTL | `workerLogin`, `externalLogin` (both issue `complete` stage directly) |
| `bearerToken` | `(req) -> string\|null` | extracts `Authorization: Bearer <token>` (case-insensitive) | `requireSession`, logout paths |
| `requireSession` | `async (req, {type, stage='complete'}) -> {session, employee}\|{session, externalUser}` | resolves + validates the bearer session and its live principal; throws 401 `httpError` on any failure | `api/auth/index.js` (`sessionEcho`), `api/work-items/index.js` + `[taskRunId]/complete.js` (`type:'employee'`), `api/orders/index.js` + `api/workflows/bulk-upload/start.js` (`type:'external'`) |
| `destroySession` | `async (token) -> boolean` | deletes the session row for a raw token; false if no token/row | logout |

## Data shapes
```js
// stored password hash (self-describing — verify reads params from the string)
"s2$16384$8$1$<salt b64>$<64-byte hash b64>"

// createSessionFor return
{ token: "<base64url, ONLY time the raw token exists>", session: /* auth_sessions row */ }

// auth_sessions row (see md/db/schema.md)
{ id, token_hash /* sha256 hex */, principal_type: 'employee'|'external',
  principal_id, stage: 'password'|'complete', expires_at, meta: {}, created_at }

// requireSession result — employee branch has .employee, external branch has .externalUser
{ session, employee: /* full employees row incl. totp_secret */ }
{ session, externalUser: /* full external_users row */ }
```
TTL constants: `COMPLETE_STAGE_TTL_MS = 12 h`. (`PASSWORD_STAGE_TTL_MS` remains in the file as a legacy constant but is unused by the current single-factor login.)

## Invariants & gotchas
- **Raw tokens are never stored.** Only sha256 hashes hit the DB, so a token can't be recovered or listed; logout/verification always requires the client-held token.
- **`requireSession` defaults `stage: 'complete'`** — all current sessions are issued as `complete` directly. Passing a falsy `stage`/`type` skips that check.
- `requireSession` **lazily sweeps** expired rows (`deleteExpiredSessions`, best-effort catch) on every call *and* re-checks `expires_at` on the found row — there is no cron; don't rely on the table being clean.
- Inactive principals 401 even with a valid unexpired session (`active` re-checked on each request via `getEmployee`/`getExternalUser`).
- `hashPassword` throws an **HTTP-shaped 400** from a lib function — intentional; routes let it bubble to `handleError`. It is the only password-length validation anywhere.
- `verifyPassword` parses scrypt params from the stored string, so changing `SCRYPT_N/R/P` only affects **new** hashes; old ones keep verifying.
- `timingSafeEqual` needs equal-length buffers: `verifyPassword` length-checks first; `verifyTotp` is safe because the regex forces both strings to 6 chars.
- TOTP helpers (`verifyTotp` skew `[-1, 0, 1]`, `base32Encode` no-padding) are **legacy/unused by login**; they remain for potential future use or tooling scripts.

## Change recipes
1. **Change session lifetime:** edit `PASSWORD_STAGE_TTL_MS` / `COMPLETE_STAGE_TTL_MS` in `api/_lib/auth.js`. Nothing else — TTL is baked into `expires_at` at creation; existing sessions keep their old expiry.
2. **Add an auth guard to a route:** `const { employee } = await requireSession(req, { type: 'employee' })` (or `type: 'external'` → `{ externalUser }`) inside the route's try/catch; `handleError` in `api/_lib/http.js` already maps the thrown 401s. See `api/work-items/index.js` for the pattern.
3. **Wire TOTP as a second factor (currently unused):** the helpers (`generateTotpSecret`, `verifyTotp`, `otpauthUrl`) exist and work; add a `workerTotp` action in `api/auth/index.js` and update `workerLogin` to issue a short-lived `password`-stage token first — see `PASSWORD_STAGE_TTL_MS` in the file.
4. **Attach data to a session:** pass `meta` to `createSessionFor` — it lands in `auth_sessions.meta` jsonb and comes back on `session.meta` from `requireSession`. No schema change needed.
5. **Change password policy:** edit the guard at the top of `hashPassword`; every create/update path in `api/auth/index.js` inherits it automatically.

## Related
- [identity repo](./identity-repo.md) — the SQL these primitives call
- [auth route](../routes/auth.md) — login flows using these functions
- [auth business model](../../business/auth-model.md) — who logs in, single-factor password policy, portal scoping
- [db schema](../../db/schema.md) — `auth_sessions` / `employees` / `external_users` DDL
- [utils](./utils.md) — `http.js handleError` that consumes `httpError`
