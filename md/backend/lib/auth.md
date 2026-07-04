# Auth Primitives — scrypt password hashing, TOTP (RFC 6238), bearer sessions
**Source:** `api/_lib/auth.js`
**Read this when:** changing password rules, TOTP behavior (digits/period/skew), session TTLs or stages, bearer-token parsing, or adding auth guards to a route.

## What it does
Dependency-free (node:crypto only) auth toolkit for the Command Center. Three concerns:
1. **Passwords** — scrypt hashing into a self-describing `s2$N$r$p$saltB64$hashB64` string, constant-time verify.
2. **TOTP** — RFC 6238 (HMAC-SHA1, 6 digits, 30 s period, ±1 window skew) plus base32 encode/decode and `otpauth://` URL for authenticator-app enrollment.
3. **Sessions** — random bearer tokens whose **sha256 hash only** is stored in `auth_sessions` (via `identityRepo.js`). Two stages: `password` (5 min, post-password/pre-TOTP for employees) and `complete` (12 h working session). `requireSession` is the guard every protected route calls.

## Key functions / exports
| name | signature (params -> return) | behavior in one line | called by |
|---|---|---|---|
| `hashPassword` | `(password) -> 's2$…' string` | scrypt-hash with fresh 16-byte salt; **throws httpError(400) if <8 chars** (doubles as validation) | `api/auth/index.js` create/update employee + external user |
| `verifyPassword` | `(password, stored) -> boolean` | parses N/r/p/salt from stored string, scrypt + `timingSafeEqual`; returns false (never throws) on any malformed input | `workerLogin`, `externalLogin` in `api/auth/index.js` |
| `generateTotpSecret` | `() -> base32 string` | base32 of 20 random bytes | `createEmployee` in `api/auth/index.js` |
| `totpCode` | `(secretB32, timestampMs=now) -> '123456'` | current 6-digit code for the 30 s counter | `scripts/totp.js` (test helper: `node scripts/totp.js <SECRET>`) |
| `verifyTotp` | `(secretB32, code, timestampMs=now) -> boolean` | requires exactly `/^\d{6}$/`; accepts counter skew −1/0/+1 (~90 s validity); constant-time compare | `workerTotp` in `api/auth/index.js` |
| `otpauthUrl` | `(username, secretB32) -> string` | `otpauth://totp/CommandCenter:<user>?...&issuer=CommandCenter` for QR enrollment | `createEmployee` |
| `base32Encode` / `base32Decode` | `(Buffer)->string` / `(string)->Buffer` | RFC 4648, no padding; decode strips non-alphabet chars and uppercases | internal to TOTP; exported |
| `httpError` | `(status, message, details=null) -> Error` | Error with `.status` (+`.details`) that `http.js handleError` maps straight to the HTTP response | throughout `api/` routes |
| `hashToken` | `(token) -> sha256 hex` | how raw bearer tokens map to `auth_sessions.token_hash` | `createSessionFor`, `requireSession`, `destroySession` |
| `createSessionFor` | `({principalType, principalId, stage='complete', meta={}}) -> {token, session}` | mints 32-byte base64url token, stores only its hash with stage-appropriate TTL | `workerLogin` (stage `'password'`), `workerTotp`, `externalLogin` |
| `bearerToken` | `(req) -> string\|null` | extracts `Authorization: Bearer <token>` (case-insensitive) | `requireSession`, logout paths |
| `requireSession` | `async (req, {type, stage='complete'}) -> {session, employee}\|{session, externalUser}` | resolves + validates the bearer session and its live principal; throws 401 `httpError` on any failure | `api/auth/index.js` (`workerTotp`, `sessionEcho`), `api/work-items/index.js` + `[taskRunId]/complete.js` (`type:'employee'`), `api/orders/index.js` + `api/workflows/bulk-upload/start.js` (`type:'external'`) |
| `destroySession` | `async (token) -> boolean` | deletes the session row for a raw token; false if no token/row | logout + `workerTotp` temp-token teardown |

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
TTL constants (top of the Sessions section): `PASSWORD_STAGE_TTL_MS = 5 min`, `COMPLETE_STAGE_TTL_MS = 12 h`.

## Invariants & gotchas
- **Raw tokens are never stored.** Only sha256 hashes hit the DB, so a token can't be recovered or listed; logout/verification always requires the client-held token.
- **`requireSession` defaults `stage: 'complete'`** — a `password`-stage temp token from `workerLogin` cannot access normal endpoints; only `workerTotp` passes `stage: 'password'`. Passing a falsy `stage`/`type` skips that check.
- `requireSession` **lazily sweeps** expired rows (`deleteExpiredSessions`, best-effort catch) on every call *and* re-checks `expires_at` on the found row — there is no cron; don't rely on the table being clean.
- Inactive principals 401 even with a valid unexpired session (`active` re-checked on each request via `getEmployee`/`getExternalUser`).
- `hashPassword` throws an **HTTP-shaped 400** from a lib function — intentional; routes let it bubble to `handleError`. It is the only password-length validation anywhere.
- `verifyPassword` parses scrypt params from the stored string, so changing `SCRYPT_N/R/P` only affects **new** hashes; old ones keep verifying.
- `timingSafeEqual` needs equal-length buffers: `verifyPassword` length-checks first; `verifyTotp` is safe because the regex forces both strings to 6 chars.
- TOTP skew loop `[-1, 0, 1]` means a code stays valid ~90 s total. Hardcoded SHA1/6-digit/30 s must match `otpauthUrl`'s query params if changed.
- `base32Encode` emits **no padding** — fine for authenticator apps, but don't feed the secret to strict decoders expecting `=`.

## Change recipes
1. **Change session lifetime:** edit `PASSWORD_STAGE_TTL_MS` / `COMPLETE_STAGE_TTL_MS` in `api/_lib/auth.js`. Nothing else — TTL is baked into `expires_at` at creation; existing sessions keep their old expiry.
2. **Add an auth guard to a route:** `const { employee } = await requireSession(req, { type: 'employee' })` (or `type: 'external'` → `{ externalUser }`) inside the route's try/catch; `handleError` in `api/_lib/http.js` already maps the thrown 401s. See `api/work-items/index.js` for the pattern.
3. **Change TOTP window/digits:** edit `hotp` (`% 1_000_000` + padStart) and `totpCode`/`verifyTotp` (`/1000/30` counter, skew array) in `api/_lib/auth.js`, then update `otpauthUrl`'s `digits`/`period` params, then re-enroll: existing authenticator apps have the old params.
4. **Attach data to a session:** pass `meta` to `createSessionFor` — it lands in `auth_sessions.meta` jsonb and comes back on `session.meta` from `requireSession`. No schema change needed.
5. **Change password policy:** edit the guard at the top of `hashPassword`; every create/update path in `api/auth/index.js` inherits it automatically.

## Related
- [identity repo](./identity-repo.md) — the SQL these primitives call
- [auth route](../routes/auth.md) — login flows using these functions
- [auth business model](../../business/auth-model.md) — who logs in, 2FA flow, portal scoping
- [db schema](../../db/schema.md) — `auth_sessions` / `employees` / `external_users` DDL
- [utils](./utils.md) — `http.js handleError` that consumes `httpError`
