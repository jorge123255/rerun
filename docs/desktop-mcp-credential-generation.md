# Canonical MCP credential generation

Lane G (`desktop/next-g-mcp-current-credential-generation`). Supplies the first missing dependency
from `docs/desktop-next-g-mcp-device-approval-handoff.md` §"Missing activation prerequisites" 1: a
canonical, durable credential generation that the device-method review can bind, and the one write
that may advance it.

Source only. No test, type check, lint, build or native QA ran; production activation stays gated.

## Pins

- Base: fork finish **d518abdbfd38985ab4c185950c22e36b1b90a269** (PR #24 merge), tree
  **94f7b0220733175e86c022befcd592752303be82**, verified clean in a new worktree.
- Original reference: `rerun-build/rerun` dev `c33c020ffb33263ec29de6f76d9b269bca786d90`.

## What already existed

`apps/ui/lib/desktop/server/mcp/store.ts` is the canonical credential store
(`desktop_remote_mcp`, `desktop_remote_mcp_oauth`, AES-GCM sealed bundle, optimistic revision,
`lifecycle` per-server generations and watchers). `mcp-device-approval` requires a `method` port
that must return trusted metadata **plus** a current credential generation, and has no default.
`mcp-device-custody` writes through `store.writeOAuth` and re-reads canonical state before each
dispatch. No durable generation existed anywhere.

## What this slice adds

| File | Change |
|---|---|
| `apps/ui/lib/desktop/server/mcp/credential-generation.ts` | the generation: `createMcpCredentialGeneration().read/advance`, opaque token, lease with deadline and check |
| `apps/ui/lib/desktop/server/mcp/store.ts` | `credentialState()` (raw sealed row, server only) and an exact conditional credential replacement; successful writes invalidate approval watchers |
| `apps/ui/lib/desktop/server/mcp/lifecycle.ts` | `invalidateCredentials()` — approval leases go stale; ordinary OAuth admission stays valid |
| `apps/ui/lib/desktop/server/mcp/credential-generation.test.ts` | authored regression (unrun) |
| `docs/desktop-mcp-credential-generation.md` | this note |

### The generation

No column, table or migration: the token is a keyed HMAC over the durable canonical rows —
`[agent, server, registration id, registration revision, sealed credential row or "none"]`. It is

- **opaque** (base64url, no readable content, never logged, never in a public view, only inside the
  encrypted review/approval records);
- **durable** (recomputable after restart from the same rows);
- **unique per state** (the sealed row carries its own IV, so even rewriting identical token bytes
  yields a different generation);
- **absent when there is no device-capable registration** (`read` returns null; a bearer-configured
  or non-http registration never gets one).

### Which exchange may advance it

`advance(agent, server, expected, bundle, signal)` first requires the expected token, then writes
through `replaceOAuth`. A single conditional write compares the immutable registration ID,
revision and exact sealed credential. A write that lost the race throws
`MCP credential generation changed` without replacing the winning row.
So only the exact approved device exchange whose lease still holds the current generation can
replace the credential.

### Invalidation

- unrelated credential write (browser sign-in, refresh, another device attempt) → the sealed row
  changes, the token changes, and `writeOAuth` invalidates the lifecycle generation, so an issued
  lease's `check()` throws `MCP capability invalidated`;
- revoke / registration delete → `read` returns null, `advance` refuses `unavailable`;
- registration edit (`save`) → new revision → new token, old lease watch invalidated;
- Stop / shutdown → the supplied Stop signal or the lifecycle check makes the lease unusable;
- expiry → the lease's own deadline aborts its signal and `check()` throws `expired`.

## Root integration seam

Inside the existing per-runtime binding the review's `method` port composes trusted broker metadata
with this module:

```ts
const generation = createMcpCredentialGeneration({ store, key: masterKey })
const lease = await generation.read(owner.owner, owner.name, signal)
if (!lease) throw new Error('MCP device registration is unavailable')
// trusted deviceMethodSchema value: { ...reviewedMethod, registrationId, credentialGeneration: lease.generation, validUntil: lease.validUntil }
```

and the custody writer advances through it instead of calling `writeOAuth` directly:

```ts
await generation.advance(approved.owner, approved.name, approved.credentialGeneration, token, signal)
```

The port must forward `lease.signal` and call `lease.check()` alongside its own checks. Nothing is
mounted here: no route, service wiring, migration or production fallback changed.

## Still gated (unchanged by this slice)

- Root's exact broker adapter: resource/issuer/endpoint validation, public-address/TLS policy,
  redirects, size/time bounds, cancellation and response shapes (network confinement is not solved
  by a schema).
- Atomic browser-versus-device selection across windows, lifecycle mounts (disable/delete, session
  Stop, credential revoke), and the migration for the review schema.
- Real network brokerage, atomic admission and production activation.

## Authored regression (unrun)

`credential-generation.test.ts`: opaque 43-char token, stable across reads, no endpoint leaked;
unrelated credential write invalidates the lease and changes the token; only the exact generation
advances (a stale advance refuses and the stored token stays the approved one); registration edit
and revoke invalidate and then report unavailable; Stop and expiry invalidate an issued lease.
Fixtures are a temp SQLite file, a fixed 32-byte key and synthetic `.example` metadata.

## Acceptance once root mounts it

Approve a device method, start the approved exchange, and confirm the credential write carries the
exact generation; run an unrelated browser sign-in or refresh first and confirm the approved write
refuses instead of overwriting it; edit or delete the registration, disable the coworker, press Stop
and let a lease expire, each invalidating the old lease; cold-restart and confirm the same
generation is recomputed while no review or lease is auto-resumed; grep logs and public responses for
the generation and find none.
