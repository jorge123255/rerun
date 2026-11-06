# Round 34 C — MCP custom headers and secret references

Source implementation and regression sources only. Root owns the contract barrel, central schema call, transport mounts, and every check. This handoff is not installed-app acceptance. Regressions below are authored and unrun.

## Verified original design mapping

Read from this worktree at base `9c8a91e187642dbf103d65887bb589b5147c8305`. Pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` is an ancestor. Behavior below is the behavior those files implement at HEAD.

- `apps/engine/src/tools/mcp-resolve.ts`: `${NAME}` in command, args, url, env, and header values. A missing name becomes `''`. The only `process.env` fallback is `RERUN_HUB_BASE_URL`. `RERUN_API_KEY` is not taken from the process. Header and env keys are not substituted. Literal `Authorization: Bearer …` passes through. Several placeholders in one string are allowed.
- `apps/engine/src/tools/mcp-hub-headers.ts`: hub `x-rerun-key` / `x-rerun-agent` are applied by `withHubHeaders`, not by this resolver.
- `apps/engine/src/tools/mcp-auth.ts`: OAuth sets `Authorization` and then spreads `server.headers`, so an existing Authorization value wins. This package refuses a second Authorization authority instead of stacking one.
- `apps/engine/src/tools/builtin/self.ts` `mcp_register`: credentials are `${KEY}` references; `request_secret` is the value path. Auth failure with a carried credential says nothing was saved.
- `apps/ui/lib/engine/mcp-secrets.ts`: the hosted editor externalizes secret-like header, env, arg, and URL spans into `${NAME}`. The Mac editor does not externalize by storing the raw value in this package.
- `apps/ui/components/agent/McpServerEditor.tsx`: labels Name, Transport, Command, Arguments, URL, Environment, Headers. Header helper begins “One Header=value per line. Sent with each request (use for auth).” This editor keeps those labels. It does not use `McpVarTextarea`, because that control changes the value behind `${NAME}`.
- `packages/contracts/src/desktop-self-mcp.ts`: env values are exactly `${NAME}`; header values are one `${NAME}` in a fixed template; URL and command placeholders are rejected; proposals are nonsecret. Mac resolution follows that subset for references and still allows literal values with no `${` so existing bearer, OAuth, and anonymous servers keep working.
- `apps/ui/lib/desktop/server/secret-requests/store.ts` `useCredential`: the only open path for `desktop_secret_credentials`. This package selects `version` itself and opens bytes only inside `useCredential`.
- `apps/ui/lib/desktop/server/mcp/lifecycle.ts` `mutate`: increments pending, aborts active controllers, runs the write on the tail, then invalidates again. Rotation uses that drain. It does not call `disconnect` a second time.
- `apps/ui/components/desktop/mcp/DesktopCoworkerMcp.tsx`: “Bearer credential configured.” and “Replace bearer (empty means anonymous)” are reused. That editor is not mounted or edited here.
- `apps/ui/components/desktop/mcp-sse/DesktopMcpSseEditor.tsx`: attempt journal, abort on unmount, “Nothing was saved…”, and “Reconcile settings” are the CAS interaction copied here.

## Contract

`packages/contracts/src/desktop-mcp-secret-references.ts`

Root adds this one barrel line. This lane did not edit `packages/contracts/src/index.ts`.

```ts
export * from './desktop-mcp-secret-references.js'
```

Public configs and proposals carry templates, reference names, `literalAuthorization`, `oauth`, and `preservedLiteralKeys`. They do not carry opened secret bytes. Connection-time configs may still contain an existing literal bearer; `beforeHttp` / `beforeSse` / `beforeStdio` accept that shape and pass it only into the transport callback.

`desktopMcpRegistrationLink` and `linkDesktopMcpProposalCredentials` always return `accepted: false`. Missing names stay `applied_pending_credentials`. Names that already have a credential version are `credentials_ready` and are still not applied.

## Server

`apps/ui/lib/desktop/server/mcp-secret-references/`

- `ensureDesktopMcpSecretReferenceSchema(db)` creates `desktop_mcp_secret_reference_heads`, `desktop_mcp_secret_references`, and `desktop_mcp_secret_reference_saves`. No sealed values. Root calls it after `desktop_agents` exists and after `ensureDesktopSecretRequestSchema`. This lane does not edit `database.ts`.

```ts
import { ensureDesktopMcpSecretReferenceSchema } from './mcp-secret-references/schema'

await ensureDesktopMcpSecretReferenceSchema(db)
```

- `createDesktopMcpSecretLookup(db, { useCredential })` reads `version` for the exact `agentId` and key. A missing row is `missing`. A different version is `rotated` and is not opened. `useCredential` runs only when the gate’s `check` passes.
- `withDesktopMcpSecrets` rechecks the owner and, when any reference exists, `selfMcpGranted`. stdio references also require `localMcpStdioGranted`. Servers with no references do not require that grant. The callback receives `inheritEnv: false` and an env object built only from the server config. Missing, invalid, and rotated references do not become `''` and do not read `process.env`.
- `createDesktopMcpSecretReferenceStore(db, { authority, commitPublicConfig })` is the CAS save. The same `saveId`, fingerprint, origin, and expected revisions replay. A different body or origin conflicts. `commitPublicConfig` must write the nonsecret public config on the same libsql transaction and throw `DesktopMcpSecretReferenceConflict` when `expectedConfigRevision` moved. When `literalAuthorization` is set and Headers have no Authorization line, root keeps the existing bearer bytes. When `preservedLiteralKeys` names a field, root keeps that existing literal and does not log it. This package does not call `SelfMcpConfigAdapter.apply`.
- `bindDesktopMcpSecretReferences({ lifecycle: remoteMcpLifecycle(), lookup, authority, records })` exposes `beforeHttp`, `beforeSse`, and `beforeStdio` for both `discovery` and `invocation`. On `rotated`, it calls `lifecycle.mutate(agentId, serverName, () => markStale(...))` once. `mutate` is the disconnect: it aborts active controllers and waits for the tail. `onSecretRotated` and `onSecretDeleted` do the same per affected server. Root calls those hooks from the canonical HTTP, SSE, and stdio discovery and invocation paths. This lane does not edit those transports.
- `createDesktopMcpSecretReferenceHandlers(null)` returns 503 `{ error: 'mcp-secret-reference-authority-unbound' }`. With a store, root passes the authenticated `{ agentId, origin }` into `get` and `post`. The body agent and origin must match that actor. There is no new `app/api` route.

```ts
const lookup = createDesktopMcpSecretLookup(db, secretStore)
const records = createDesktopMcpSecretReferenceStore(db, {
    authority: selfMcpAuthority,
    commitPublicConfig: async ({ agentId, serverName, expectedConfigRevision, config, tx }) => {
        // CAS the canonical MCP row on tx. Preserve bearer bytes when
        // config.literalAuthorization is true and Authorization is absent.
        // Preserve config.preservedLiteralKeys. Do not copy process.env.
        return { configRevision: expectedConfigRevision }
    },
})
const mcpSecrets = bindDesktopMcpSecretReferences({
    lifecycle: remoteMcpLifecycle(),
    lookup,
    authority: selfMcpAuthority,
    records,
})
// Immediately before HTTP discovery and invocation:
await mcpSecrets.beforeHttp({ agentId, serverName, phase, config: rootConnectionConfig }, async material => {
    // material.inheritEnv === false. Do not merge process.env into material.env.
    // Do not add a second Authorization when material.headers already has one
    // or when the admission authority is oauth (root withAuth remains that path).
})
```

`rootConnectionConfig` is the live MCP server, which may contain a literal bearer. The editor save config is the public template record. Root must not pass the public record to `beforeHttp` in place of the live server, or a preserved bearer would be missing at connect time.

`desktopMcpSecretReferenceRedirectIssue(savedUrl, nextUrl)` refuses a cross-origin target, a credential, a fragment, a placeholder, and any query that is not one SSE `sessionId` / `session_id`. Root calls it anywhere a redirect or advertised endpoint is followed. The SSE client is unchanged and already refuses cross-origin endpoints.

## UI

`apps/ui/components/desktop/mcp-secret-references/DesktopMcpSecretReferenceEditor.tsx`

`apps/ui/components/desktop/mcp-secret-references/editor-state.ts` is the client module: slot key, attempt id, same-owner check, public save body, and fingerprint. It is not registered in a root-owned barrel.

The panel uses `PanelEditorShell`, the original field labels, wrapping footer actions, and `min-h-9` controls. Requirement rows say Pending or Configured. “Request credential” calls the injected `onRequestSecret` and never collects a value. Existing bearer text is not an input. Unmount aborts the journal request. Root mounts the editor; this lane does not edit `DesktopCoworkerMcp.tsx`.

## Supported and unsupported

Supported: one `${NAME}` in a header template, an environment value, or a whole argument; literals with no `${`; one of reference, bearer literal, OAuth, or anonymous; same-origin redirect check; versioned opens through `useCredential`.

Unsupported, and rejected with a message rather than dropped: empty-string substitution; several placeholders in one value; `${}` in a URL, command, header name, or environment name; an embedded placeholder in an argument or environment value; stdio HTTP headers; `RERUN_HUB_BASE_URL` or any other `process.env` fallback in this resolver; nested or non-`[A-Za-z_][A-Za-z0-9_]*` names; cross-owner references; cross-origin redirects; raw, base64, hex, percent-encoded, or JSON-escaped secret echoes.

Caps: 32 headers, 32 env entries, 64 arguments, 32 references per field, header name 128, header template 512, resolved value 8192 bytes, argument 1024, command 1024, URL 2048.

## Matrix

| | State |
| --- | --- |
| Contract, public CAS save, lookup, resolver, proposal link, redaction, redirect check, rotation `mutate` hook, editor, client module | Implemented in this lane |
| Barrel export, `ensureDesktopMcpSecretReferenceSchema` call, `commitPublicConfig`, transport calls to `beforeHttp` / `beforeSse` / `beforeStdio`, `onSecretRotated` / `onSecretDeleted` from the credential store, editor mount, handler route, self-MCP grant reader | Root-owned wiring |
| Engine empty-string substitution, multi-placeholder expansion, URL and command placeholders, process.env fallback, hub header injection, OAuth token storage, Keychain, a second secret store | Unsupported here |

## Regressions

Authored and unrun. Root runs them.

- `apps/ui/lib/desktop/server/mcp-secret-references/references.test.ts`
- `apps/ui/lib/desktop/server/mcp-secret-references/store.test.ts`
- `apps/ui/components/desktop/mcp-secret-references/editor-state.test.ts`

They cover missing references, `RERUN_API_KEY` and `RERUN_HUB_BASE_URL`, multiple placeholders, URL and command placeholders, key placeholders, one Authorization authority, literal passthrough, `inheritEnv: false`, redaction of raw and base64 echoes, one `mutate` on rotation, cross-owner refusal, proposal non-acceptance, CAS replay and conflict, sealed-value SQL, and editor output that omits an existing bearer.
