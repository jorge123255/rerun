# Round 38 F — multiple API-key connections, custody and execution snapshots

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-f-api-connections`, branch `desktop/round38-f-api-connections`, prepared HEAD `6f6ad959a09abaf1947950b6f82413c94407e22a`.

Source handoff only. No tests, typecheck, lint, builds, installs, provider/network calls, live Keychain, browser/native UI or restart checks were executed. This is not installed acceptance.

## Published contract for G

Read-only UI contract: `packages/contracts/src/desktop-api-connections.ts`, `DESKTOP_API_CONNECTIONS_CONTRACT_VERSION = 1`.

- Initial contract commit: `764a9a44b4436ee8fd43c9e022c797fdf513996e`.
- Default-reference compatibility commit: `04d575dad34f273252eb7c18494e167dac7f1206`.
- Runtime implementation commit: `1680a0c683c27866f2d86b7a14a0a435409e8448` (`Add durable API connection lifecycle`). The implementation worktree was clean apart from this uncommitted handoff, which is committed separately.

G can consume these types without copying files or depending on the implementation commit. No barrel was edited.

Public DTOs:

- `DesktopApiConnectionView` / `desktopApiConnectionViewSchema`: workspace, connection ID/revision, provider, name, models, optional base URL, connection/rejection state and created time. No `env`, secret, token or key field.
- `DesktopApiConnectionCatalog`: redacted siblings plus current default. Default references allow existing Codex/Claude IDs; new API-key connection IDs use `cnx_…` and revisions `rev_…`.
- `DesktopApiExecutionSnapshot`: immutable workspace/connection/revision/provider/model/reasoning/base URL/allowed models/source/run/request/session/capture time. It contains no credential.
- `DesktopApiRemovalPlan`: exact connection usage, pending runs, preserved sibling IDs, `canRemove` and reason for G’s confirmation UI.
- Create/rename/models/credential/select/remove inputs and `DesktopApiMutationResult` / receipt: `saved | refused | uncertain`, with same-request `recovered` identity.

## Original and canonical mapping

Original `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `AddProviderPage.tsx`: name plus write-only key, immediate create, distinct connection detail and original error behavior.
- `AiProvidersPanel.tsx`: multiple named sources, list/add/detail flow, default selection and removal consequences.
- `ConnectionDetail.tsx`: immediate rename/model/credential edits and rejected-key replacement.
- `DeleteConnectionButton.tsx`: usage read before confirmation, then released agents/automations/default messaging.

Canonical runtime:

- `connections/store.ts`: creates a new ID by default, stores config and encrypted `.env`; patch and update-keys operate on that exact ID. The adapter calls it rather than replacing custody.
- `lib/env-file.ts`: AES-256-GCM desktop custody and 0600 files. D never calls Keychain or reads live secrets.
- `connections/loader.ts` / `registry.ts`: redacted summary basis and exact-ID reads. `env` remains server-local.
- `connections/default.ts`: workspace default writes and cache invalidation. In-flight runs retain their own selection.
- `connections/release.ts`: exact agents/automations/isBoxDefault usage and release behavior. D adds pending-run drain and preserved sibling IDs.
- `agents/availability.ts`: default model selection from the selected connection only.
- `agents/providers.ts` and desktop chat-model settings: existing `connectionId`-scoped resolution. Codex/Claude subscription paths, RD37 custom provider and OpenCode modules are unchanged.

## Owned implementation

- `store.ts`: `DESKTOP_API_CONNECTIONS_SCHEMA_SQL`, `sqliteDesktopApiConnectionStore`, `memoryDesktopApiConnectionStore`. Durable connection revisions and request receipts. Only nonsecret receipt/result DTOs are stored.
- `service.ts`: redacted catalog, create/rename/models/credential/select/remove, revision checks, same-request reconciliation, Stop handling, ambiguous-ack recovery, removal planning and immutable snapshots.
- `canonical.ts`: direct binding to the canonical connection store, release and default functions.
- `runtime.ts`: schema initializer and runtime factory with canonical authority, generated `cnx_`/`rev_` IDs and injected run-drain authority.
- `contract.test.ts`: strict redaction, existing default IDs and deterministic canonical JSON.
- `service.test.ts`: sibling creation/selection, default protection, removal blocking/release, same-request create recovery, Stop, stale snapshot refusal and ambiguous create/remove acknowledgements.

No successful probe is invented. Validation/probing is separate from saving; this package does not perform provider probes.

## Exact root activation

### Contract and migration

Add to `packages/contracts/src/index.ts` and rebuild:

```ts
export * from './desktop-api-connections.js'
```

Append the next free desktop migration, without renumbering any shipped step:

```ts
import { DESKTOP_API_CONNECTIONS_SCHEMA_SQL } from '../desktop/api-connections/store.js'

{
    version: /* next free integer */,
    id: 'desktop-api-connections',
    up: async () => {
        if (!desktopApp()) return
        await db.executeMultiple(DESKTOP_API_CONNECTIONS_SCHEMA_SQL)
    },
}
```

Alternatively call `initializeDesktopApiConnections(db)` during the desktop initialization that owns the same migration. It creates only revision and receipt tables; no secret columns exist.

### Runtime composition

```ts
const connections = await createDesktopApiConnectionRuntime({
    workspaceId,
    pendingRuns: async connectionId => desktopRunAuthority.pendingRuns(connectionId),
    stopAndDrain: async connectionId => desktopRunAuthority.stopAndDrain(connectionId),
})
```

`pendingRuns` must return actual `DesktopApiPendingRun` entries with run/session IDs and captured connection revision. `stopAndDrain` must stop those exact runs and refuse new admissions until release completes. Do not return an invented empty list: missing drain authority makes `canRemove` false and removal refuses.

### G’s list/mutation mounts

- List: `connections.list(workspaceId)`.
- Create: `connections.create(input, signal)`.
- Rename: `connections.rename(input, signal)`.
- Models: `connections.models(input, signal)`.
- Replace key: `connections.credential(input, signal)`.
- Select default: `connections.select(input, signal)`.
- Confirmation read: `connections.removalPlan(workspaceId, connectionId)`.
- Remove: `connections.remove(input, signal)`.

Use `expectedRevision` from the current redacted view for every mutation. `recovered:true` means an identical request was reconciled, not a second effect. `uncertain` never authorizes replay with a new request ID; inspect the current state and reconcile the original request.

### Execution snapshot binding

At run start only:

```ts
const snapshot = await connections.executionSnapshot({
    connectionId: selected.connectionId,
    source: 'workspace', // or coworker/conversation/foreman/auxiliary
    runId,
    sessionId,
    requestId,
    model,
    reasoningEffort,
})
const { secret, ...publicSnapshot } = await connections.credentialForSnapshot(snapshot)
```

Resolve the existing provider with `publicSnapshot` and `secret` only in memory. Keep the resulting model/credential in run locals; never write them to chat, logs, history, catalogs or portable files. Do not call `credentialForSnapshot` again mid-run. A later key/model mutation changes the revision and rejects a stale snapshot instead of rebinding it.

### Removal and shutdown

- G reads `removalPlan` and displays `usage.agents`, `usage.automations`, `usage.isBoxDefault`, `pendingRuns`, and the reason when `canRemove` is false.
- Root drains exact pending runs before `releaseConnection` and rechecks the plan. Release affects only consequences attached to the removed connection; `preservedConnectionIds` records untouched siblings.
- `released` in the result is the exact canonical usage returned by `releaseConnection`. Unrelated workspace defaults and sibling credentials are not erased.
- Root closes pending work on workspace/runtime shutdown and retains uncertain receipts for reconciliation rather than repeating mutations.

## Persistence, redaction and recovery semantics

- `desktop_api_connection_revisions` is the durable revision authority; existing connections receive deterministic initial revisions and each mutation advances them.
- `desktop_api_connection_receipts` stores request ID, kind, workspace, connection/revision, SHA-256 fingerprint, receipt and redacted result. Secret-bearing inputs are never stored. The fingerprint is not a credential.
- Same ID + same fingerprint returns the original result. Changed input refuses. Pending work is inspected and completed only when the canonical state and intended next revision match; otherwise it remains `uncertain` with no automatic second effect.
- Abort before an effect returns `refused`. An ambiguous acknowledgement after an effect returns `uncertain`, then same-request inspection can finish saved without another create/release/delete.
- Connection views contain no `env` or secret field and strict schemas reject them. Secret comparison used for reconciliation stays inside the server.
- A removed connection’s usage and release are exact; sibling IDs remain. A stale snapshot or removed credential cannot silently redirect a pending run to a sibling.

## Implemented / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Distinct sibling creation | Implemented with canonical new IDs | Migration and UI mount |
| Redacted catalog | Implemented, strict schemas | Existing-provider catalog acceptance |
| Rename/model/credential edits | Implemented with revision fences | Root Settings writes and real encrypted save QA |
| Default selection | Implemented with immutable snapshot | Sidebar/chat/Foreman/auxiliary resolution mounts |
| Removal plan and release | Implemented with exact usage and preserved siblings | Real pending-run/drain authority and confirmation mount |
| Same-request recovery | Implemented with redacted receipts | Migration and restart/ambiguous-ack acceptance |
| Stop and stale responses | Implemented | Root lifecycle/cancellation acceptance |
| Provider probing | Not performed and never claimed successful | Separate authorized probe authority if needed |
| Codex/Claude/OpenCode/custom-provider edits | Unsupported here | Their canonical modules remain unchanged |
| Live Keychain, secret output or portable secret export | Explicitly unsupported | Must remain unsupported |
| Installed acceptance | Not run | Root runs all checks and repairs |

## Authored but unrun regressions

- `contract.test.ts`: strict redaction, existing default IDs and canonical JSON.
- `service.test.ts`: distinct siblings, redacted catalog, selected execution identity, default protection, removal blocking/release, same-request recovery, Stop, stale snapshot refusal and ambiguous create/remove recovery.

No checks were executed. Root owns review, fixes, all tests, packaging and board/full-restart acceptance.

## Known limits

- Runtime and UI composition are required before the package is reachable. Missing DB migration or run-drain authority is a real unavailable state, not success.
- Existing connections need the revision initializer to adopt their initial revision; new mutations require the current redacted revision.
- `uncertain` is not proof of failure or success and never permits a blind new request.
- Secret equality is used only for server-side reconciliation. Public views and receipts never include it.
- A stale execution snapshot must start a new run; root must not substitute a sibling or silently refresh credentials mid-run.
- The memory store is regression support only. Production uses the canonical SQLite store after root’s migration.
