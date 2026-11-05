# Round 32 F handoff — custom service headers and additional accounts

Agent F. Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round32-service-accounts`, branch `desktop/round32-service-accounts`, base `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`. Original pin read from this tree: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` (HEAD was the base, so the untouched files match that tree).

This does not close E4. Do not check the E4 box in `docs/desktop-parity-checklist.md`. No live authentication, probe, or Mac restart acceptance was run. Regression sources are authored and unrun. Root runs tests, typecheck, lint, builds, migrations, and board/restart acceptance.

## Original design mapping

| Original | Reused by this lane |
| --- | --- |
| `packages/contracts/src/service.ts` `serviceRegistryKey` / `parseServiceRegistryKey` / `SERVICE_INSTANCE_ID_RE` | Base key is the bare slug. Another account is `slug@` plus six `[a-z0-9]` characters. A label is not a key. |
| `apps/ui/lib/services/instances.ts` `ordinalInstanceLabel`, `instanceServerName`, `newServiceInstanceId` | Labels are `App 2`, `App 3`. Server names are `template-instanceId`, one hyphen, at most 64 characters. Production ids come from `newServiceInstanceId`. Tests inject the id port and must not call `randomInt`. |
| `AgentPanelServices` / `ServiceList` | Installed and Discover. `Add account` is shown by `ServiceList` only when `installStatus === 'active'`, `multiInstance`, and `onAddAccount` are set. This lane also requires `additionalAccountVisible` (supported method). |
| `AuthMethodPicker`, `ServiceFields`, `ServiceConfigForm` | Method order, secret password fields, and per-account draft state. No env-file secret write. |
| `compileLocalService` | Anonymous (kind `none`, or zero inputs and zero headers) and exact `Authorization: Bearer ${input.KEY}` stay valid. This compiler does not replace that function. |
| Desktop service store bearer column | Still the exact-Bearer mirror. AAD remains `desktop-service-bearer-v1`. Header bundles use a different AAD and table. |

## What this lane owns

- `packages/contracts/src/desktop-service-accounts.ts`
- `apps/ui/lib/desktop/server/services/accounts/**` (compiler, availability, lifecycle, transport, secrets, reservations, feature, wire, regression sources)
- `apps/ui/components/desktop/services/accounts/**`
- `apps/ui/lib/desktop/service-accounts-client.ts` and its test
- `apps/ui/app/api/desktop/coworkers/[agentId]/service-accounts/route.ts`
- this handoff

No existing compiler, lifecycle, store, schema, binding, api, bridge, catalog, skill-resources, Apps panel, remote MCP, contract barrel, or migration file was edited.

## Capability matrix

| Capability | Source in this lane | Live Mac acceptance |
| --- | --- | --- |
| Anonymous and exact Bearer through the new adapter | ✓ | — |
| Catalog fixed and `${input.KEY}` headers | ✓ | — |
| Additional `multiInstance` account | ✓ | — |
| Encrypted per-account header bundle | ✓ | — |
| Same-request allocation and restart replay | ✓ | — |
| Account-scoped probe and tool call | ✓ | — |
| Apps mount beside the current panel | ✓ | — |
| OAuth, managed, Composio, paid, stdio, SSE | — | — |
| Hosted account selection or provider revocation | — | — |
| E4 checklist close | — | — |

## Root wiring

1. Barrel. In `packages/contracts/src/index.ts`, next to the desktop-services export, add `export * from './desktop-service-accounts.js'`. Do not add a deep package export. Until that lands, callers use the relative `packages/contracts/src/desktop-service-accounts` import already used here. `@rerun/contracts` does not expose this module yet.

2. Migration. Copy `DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL` from `apps/ui/lib/desktop/server/services/accounts/schema.ts` into the canonical desktop migration. `openDesktopServiceAccounts` also runs the idempotent `CREATE TABLE IF NOT EXISTS` initializer on the existing desktop database. It does not open a second database or keychain.

```sql
CREATE TABLE IF NOT EXISTS desktop_service_account_mutations (
    owner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL,
    account_key TEXT,
    installation_id TEXT,
    revision TEXT,
    public_result TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, request_id)
);
CREATE TABLE IF NOT EXISTS desktop_service_header_secrets (
    owner TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    bundle TEXT NOT NULL,
    PRIMARY KEY (owner, installation_id)
);
CREATE TABLE IF NOT EXISTS desktop_service_account_tombstones (
    owner TEXT NOT NULL,
    account_key TEXT NOT NULL,
    retired_at TEXT NOT NULL,
    PRIMARY KEY (owner, account_key)
);
```

`bundle` is AES-256-GCM (`iv || tag || ciphertext`, base64). AAD is `JSON.stringify(['desktop-service-header-v1', owner, installationId, revision])`. `public_result` is public result JSON only. Do not store header values in `desktop_service_installs.plan`.

3. Bind the route inside the desktop MCP binding, next to the existing `localServiceLifecycle(installedServices, serviceAuthority, …)` call in `apps/ui/lib/desktop/server/mcp-binding.ts`. `serviceAuthority` is the local `ServiceAuthority` closure already passed there. It is not exported. `masterKey` reads `process.env.RERUN_DESKTOP_SECRET_KEY` (64 hex characters) and stays private. Do not log it.

```ts
bindDesktopServiceAccounts(runtime => openDesktopServiceAccounts(runtime, {
    keyReader: masterKey,
    authority: {
        current: async (coworkerId, action, signal) => {
            const value = await serviceAuthority(coworkerId, action, undefined, signal)
            return { engineAgentId: value.engineAgentId, enabled: value.enabled, granted: value.granted, skillsRoot: value.skillsRoot, launchNonce: value.runtime.launchNonce }
        },
    },
    skills,
    assertToolNames,
}))
```

`bindDesktopServiceAccounts` is exported from `apps/ui/app/api/desktop/coworkers/[agentId]/service-accounts/route.ts`. `openDesktopServiceAccounts` is exported from `apps/ui/lib/desktop/server/services/accounts/wire.ts`. Until that bind runs, GET and POST return 503 `Service account routing is not wired to the desktop credential authority.`

4. Mount `DesktopServiceAccountsMount` from `apps/ui/components/desktop/services/accounts/DesktopServiceAccounts.tsx` beside the current Apps panel. Do not replace `DesktopCoworkerServices` or edit it in this lane. The mount talks only to `/api/desktop/coworkers/${agentId}/service-accounts`.

5. Skill port. `skill-resources.ts` already exports `createServiceSkill`, `verifyServiceSkill`, and `removeServiceSkill`. It does not export a reference count. Inject:

```ts
skills: {
    create: (root, installationId, index, skill, guard) => createServiceSkill(root, installationId, index, skill, guard),
    verify: (root, owned) => verifyServiceSkill(root, owned),
    remove: (root, owned, guard) => removeServiceSkill(root, owned, guard),
    referencedInstallations: async (owner, skillSlug, exceptInstallationId) => count,
}
```

`referencedInstallations` must exclude `exceptInstallationId`. The owned slug from `createServiceSkill` is `svc-${installationId without dashes, slice 0, 16}-${index}`. This lifecycle also counts other install rows that list the same slug. It deletes the directory only when both counts are 0. If the manifest has skills and no port is injected, install and remove throw `Service usage-skill bundles are not available on this Mac yet.` Skill bodies that contain `${` are refused. Round 31 files were not edited.

6. Tool names. The default guard checks uniqueness, `/^[\w.-]{1,128}$/`, and that no name starts with another non-disconnected account's `serverName + '_'`. Pass the same `assertToolNames` closure already given to `localServiceLifecycle` (reserved `desktopRerunToolCatalog` / `desktopCodexToolCatalog` names, plus remote, local, and service prefixes). Its current error text is `Service tool conflicts with another tool`, which is not in the account message allowlist, so the feature returns the generic refusal. Do not edit `mcp-binding.ts` in this lane.

7. Old service API. `apps/ui/lib/desktop/server/services/api.ts` still serves `/api/desktop/coworkers/[agentId]/services`. Its detail path rejects an instance slug and forces `multiInstance: false`. Its POST `mutate` still addresses rows by key. Root should refuse instance keys and rows whose plan has `headerPlan` or `shape` on that old route so it cannot disconnect, probe, or overwrite an account created here. `classifyDesktopServiceMethod` / `localMethodAvailability` still mark custom headers unsupported. The new catalog path uses `accountMethodAvailability` only. Do not make the old classifier fall through to this compiler.

8. Restart update in `mcp-binding.ts` (not edited). On bind it sets every install's health to unchecked and clears tool names. It then sets `preparing` / `removing` rows, and rows whose `engine_id` does not match the agent, to `error` and clears the bearer column. Ready custom-header rows keep their ciphertext in `desktop_service_header_secrets`. A crash that left a row `preparing` becomes `error` and loses the bearer mirror; the header bundle remains if it was sealed. Retry of the same request id can publish `ready` again. Root can exempt header-plan rows from that error update. This lane did not change the update.

## Contract and dependencies

Public mutation body is `desktopServiceAccountMutationSchema`: install `new` | `additional`, or reconfigure / probe / disconnect / remove `existing` with `accountKey` and `expectedRevision`. Values are a string record. The body has no engine id, URL, or raw header map. The route rejects those keys before parse.

`DesktopServiceAccountView` extends `desktopInstalledServiceSchema` with `installationId`, `shape` (`anonymous` | `bearer` | `headers`), `headerPlan` (name, source, input keys, secret flag), `configured`, `configuredInputs` (keys whose value is `true`), and `publicInputs`. Compiled header values are not on the view.

Every operation binds `coworkerId` plus the current engine owner from `authority.current`. A label is display only. Account cap is `DESKTOP_SERVICE_ACCOUNT_LIMIT` (64), including live keys and other requests' non-complete allocated keys. The refusal is `This coworker already has 64 service accounts. Remove one before adding another.`

Relative type imports, because the barrel is root's:

- server accounts → `../../../../../../../packages/contracts/src/desktop-service-accounts` (7)
- `apps/ui/lib/desktop/service-accounts-client.ts` → `../../../../packages/contracts/src/desktop-service-accounts` (4)
- account components → `../../../../../../packages/contracts/src/desktop-service-accounts` (6)

`callTool` is not an HTTP route. Root's engine bridge should call `feature.lifecycle.callTool` for the selected account after a fresh healthy probe. It sends that account's headers only to that account's URL.

## Credentials, ownership, cancel, restart

- Exact Bearer still mirrors the token into the existing bearer column. Custom headers pass `''` for that column and store `{ headers, inputs }` in `desktop_service_header_secrets`. Anonymous stores no bundle.
- Blank secret fields reuse the stored input only for `intent.kind === 'existing'` when a bundle exists at the current revision. A new account with a blank required secret fails. A display mask (`•`, `*`, `·`, `.`) is rejected and not written.
- `openStoredHeaderBundle` turns cipher failures into `Secret write conflict` and does not include the ciphertext. Do not log bundles, plans-with-values, or thrown crypto errors.
- Saving configuration does not call the network and does not turn the Apps grant on. Status stays `needs_config` until a later probe is healthy under an enabled grant. Health is fresh for 60 seconds against the injected clock and launch nonce.
- The old desktop lifecycle still requires disconnect before reconfigure, and disconnect deletes the bearer. This adapter allows a revision-checked reconfigure from `ready` so a blank field can keep the secret. `removing` still conflicts. Disconnect and remove clear that account's secret, do not call the provider, and do not reconnect. Copy: `Local credentials removed. This does not revoke the remote API key.`
- Remove tombstones the account key. Removed instance ids are not reused. The base slug can be installed again after the base row is gone; a bare slug is not an instance id.
- Same `requestId` plus the same canonical fingerprint replays the allocated installation. A changed body with that request id throws `Request identity reused`. In-process matching calls share one promise. Fingerprints are HMAC of canonically sorted JSON. `serviceStoreInstalls` sorts before `store.digest`, which itself does not sort.
- Probe that is already `probing` returns `Prior request acknowledgement unavailable; inspect connection state.` and does not call the network. A completed probe replays and does not call again. The client drops a probe request id after `unknown`, `probed`, or `removed`, so the next click is a new request. Install, reconfigure, disconnect, and remove keep the id.
- Abort during probe returns `unknown` / `MCP operation cancelled or timed out`, leaves the reservation `probing`, and does not write a false connection error. The next same-id call is the lost-ack unknown above.
- Disconnect of a missing row returns `The original installation no longer exists. This request will not be replayed.` and does not complete the reservation. Remove of a missing row tombstones it and completes as removed.
- A stale `expectedRevision` refuses before secret removal. One owner is serialized. A reconfigure that wins a race keeps the new secret; the stale remove throws `Service revision conflict`.
- Stale engine (`authority.engineAgentId !== binding.engineOwnerId`, or the install's engine id) throws `Service installation belongs to a previous engine identity` before effects.
- Transport uses `redirect: 'manual'` and `credentials: 'omit'`. A 3xx or opaque redirect fails closed and does not send the headers to `Location`. `Content-Type`, `Accept`, and `MCP-Protocol-Version` are set after the account headers. Tool results redact header values of length 4 or more. GET, catalog, and history do not probe.
- Form drafts are keyed by installation id (or `new:` / `additional:` before save). Cancel before submit writes nothing. Cancel while the submit is in flight keeps the client request id and shows reconciliation copy. A late result is dropped when the form unmounts, the epoch changes, or the selected account changes.
- Kind `none` plus headers is refused (`Unsupported anonymous service configuration`). Custom headers require kind `key` (or the exact Bearer shape). Unknown method ids do not fall back through `getMethod`.

## Regression sources (authored, not run)

- `apps/ui/lib/desktop/server/services/accounts/compiler.test.ts`
- `apps/ui/lib/desktop/server/services/accounts/secrets.test.ts`
- `apps/ui/lib/desktop/server/services/accounts/transport.test.ts`
- `apps/ui/lib/desktop/server/services/accounts/lifecycle.test.ts`
- `apps/ui/lib/desktop/server/services/accounts/feature.test.ts`
- `apps/ui/lib/desktop/service-accounts-client.test.ts`
- `apps/ui/components/desktop/services/accounts/DesktopServiceAccountForm.test.tsx`
- `apps/ui/components/desktop/services/accounts/DesktopServiceAccounts.test.tsx`

Harness: `accounts/regression-harness.ts`. Fake network, memory secrets, memory installs, and an injected clock only. No Keychain, sqlite file, or live HTTP.

Covered by those sources: original key/label parsing, fixed and custom headers, case collision, CR/LF, hop-by-hop headers, secret substitution, unsupported methods, no `getMethod` fallback, secret leakage into plan/result JSON, account separation, base and sibling preservation, same-request allocation, conflicting reuse, secret reconfigure/remove ordering, cancel and lost probe acknowledgement, restart replay, stale owner, the 64-account message, skill reference retention, feature GET without probe, and rejected engine/header bodies.
