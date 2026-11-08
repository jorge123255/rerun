# Round 37 D — original OpenCode connection, models and limits UI

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round37-opencode-ui`, branch `desktop/round37-opencode-ui`, prepared base `e87edabffded9b56c67f98539a412e230959435c`. Runtime ancestor `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`.

Implementation commit `8199826d2140ec25684e8b0392d572942cb6b160` (`Add desktop OpenCode connection UI`). The implementation worktree was clean apart from this uncommitted handoff document, which is committed separately.

Source handoff only. No tests, typecheck, lint, builds, installs, servers, fixtures, provider/network calls, Docker, browser/native UI, microphone, Keychain or restart checks were executed. This is not installed acceptance. The current Codex-only connected state is unchanged.

## Exact dependent revisions

- **C / Grok Worker A:** contract and handoff commit `440d9b283aae1ed362eca3daab4aa05493ceaaef`, implementation `3046db1c5bcb274927d2d80a1aa8b20600abd6ba`, branch `desktop/round37-opencode-runtime`.
- **Contract:** `packages/contracts/src/desktop-opencode.ts`, `DESKTOP_OPENCODE_CONTRACT_VERSION = 1`.
- **C adapters consumed:** `desktopOpencodeRequestSchema`, `publishDesktopOpencode`, `handleDesktopOpencode`, `DesktopOpencodeAuthority`, and `DesktopOpencodeAuthoritySnapshot` from `apps/ui/lib/desktop/server/opencode/`.
- **Original comparison:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in read-only `upstream-review-20261106`; historical acceptance pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

No second catalog, account, credential, model, plan, usage, receipt or workspace shape was introduced. D does not copy C’s files into its worktree.

## Original source/design mapping

Read the mounted original components at the comparison pin:

- `connections/AiProvidersPanel.tsx`: list → add → detail flow, workspace default first, source grouping, connection status, reconnect and fallback behavior.
- `connections/AddProviderPage.tsx`: connection name, write-only API key, original OpenCode credential guide, busy/error and Connect behavior.
- `connections/ConnectionDetail.tsx`: detail header, immediate model edits, plan limits before models, rejected-key replacement and bottom destructive action.
- `connections/OpencodeModels.tsx`: Go section before Console, Included/Credits badges, search across both plans, per-model switches, default/last-model lock reasons, unavailable rows and price-per-million presentation.
- `connections/PlanLimitsBlock.tsx`: Plan usage title, captured-age, empty reading text and window meters.
- `connections/SourceBits.tsx`, `DetailBlock.tsx`, `DefaultModelPicker.tsx`, `DeleteConnectionButton.tsx`: source status/avatar, section layout, default protection and confirmed removal.
- `packages/contracts/src/opencode.ts`: Go/Console ids, plan descriptions, snapshot/catalog behavior and usage windows.

D preserves those components’ ordering, labels, interactions and responsive treatment. Intentional Mac adaptations are C’s explicit Console opt-in, durable catalog/revision fences, authenticated loopback adapters, write-only snapshot marker, and exact Settings callbacks. No commercial `ee` or `(ee)` code is used.

## Owned implementation inventory

### `apps/ui/components/desktop/connections/opencode/`

- `DesktopOpencodeConnection.tsx`: add/edit/reconnect page, masked credentials, original guide, name edit, catalog/usage reads, revision-fenced saves and confirmed disconnect/discard.
- `DesktopOpencodeModels.tsx`: original Go/Console sections, search, counts, Included/Credits/New/No vision badges, prices, retired rows, default/last locks and explicit Console opt-in.
- `DesktopOpencodePlanLimits.tsx`: original Plan usage presentation, 5-hour/weekly/monthly windows, reset text, age and manual refresh.
- `DesktopOpencodeDefaultSelect.tsx`: shared sidebar/chat/Foreman/auxiliary selector with enabled-model filtering, selected-model preservation and revision callback.
- `DesktopOpencodeConnection.test.tsx`, `DesktopOpencodeModels.test.tsx`: real mounted regressions, authored and unrun.

### `apps/ui/lib/desktop/opencode/`

- `driver.ts`: typed UI port and masked connection snapshot schema; settings/default callback types carry `expectedConnectionRevision`.
- `client.ts`: concrete same-origin driver for C prepare/catalog/refresh/usage/enable/disconnect plus the masked snapshot read. No engine credential enters renderer headers.
- `api.ts`: authenticated desktop route adapter. It forwards C calls server-side with the existing engine credential, and binds C’s same authority for a masked snapshot DTO. `oc_sk_write_only` is a marker, not a credential.
- `useDesktopOpencodeSnapshot.ts`: observational snapshot/catalog loader for root mounts, with cancellation and stale-response protection.
- `client.test.ts`: exact route/action/header and refused-result regressions, authored and unrun.

## Exact root activation fragments

No central file was edited here.

### 1. Integrate C first

Apply C’s implementation at `3046db1c5bcb274927d2d80a1aa8b20600abd6ba` and handoff commit `440d9b283aae1ed362eca3daab4aa05493ceaaef`: contract barrel and rebuild, provider registry/model resolution, catalog/usage store migration, execution binding, and C’s engine route. D’s route adapter returns `unavailable` until C’s ports are bound.

Provider registration from C remains required:

```ts
// packages/contracts/src/agent.ts
providerSchema: add 'opencode'

// packages/contracts/src/connection.ts
CONNECTION_TOKEN_KEY.opencode = 'OPENCODE_API_KEY'
CONNECTION_SATELLITE_KEYS.opencode = []
DEFAULT_CONNECTION_MODELS.opencode = desktopOpencodeDefaultModelIds()
PROVIDER_LABELS.opencode = 'OpenCode'
```

`desktopProvider` in `apps/ui/lib/desktop/settings.ts` adds `'opencode'` to `apiProvider`. Key writes validate with `desktopOpencodeKeyProblem`; ChatGPT/Anthropic/OpenAI/OpenRouter credentials are not accepted.

### 2. Mount D’s authenticated routes

`apps/ui/app/api/desktop/opencode/route.ts`:

```ts
export { handleDesktopOpencodeUi as GET, handleDesktopOpencodeUi as POST } from '@/lib/desktop/opencode/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
```

`apps/ui/app/api/desktop/opencode/connection/route.ts`:

```ts
export { handleDesktopOpencodeConnection as GET } from '@/lib/desktop/opencode/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
```

When C binds its ports, also bind the exact same authority for the masked DTO:

```ts
import { bindDesktopOpencodeUiAuthority } from '@/lib/desktop/opencode/api'

bindDesktopOpencodeUiAuthority(authority)
```

Do not bind a second account catalog or expose `authority.current` directly to the renderer. D’s handler substitutes `oc_sk_write_only` for any present key and checks workspace/launch nonce.

### 3. Carry expected revisions through Settings writes

Extend the key/models/default variants in `settingsChange` with optional `expectedConnectionRevision`. Add:

```ts
z.object({ action: z.literal('rename'), connectionId: id, name: id, expectedConnectionRevision: z.string().optional() }),
z.object({ action: z.literal('disconnect'), connectionId: id, expectedConnectionRevision: z.string().optional() }),
```

Before an OpenCode key/model/default/rename/disconnect write, root checks the same C authority:

```ts
const snapshot = await authority.current({ workspaceId: runtime.workspaceId, connectionId: change.connectionId }, undefined)
if (!snapshot || snapshot.launchNonce !== runtime.launchNonce || snapshot.connectionRevision !== change.expectedConnectionRevision) {
    throw new DesktopHttpError(409, 'OpenCode connection changed. Reload it before saving.')
}
```

For `rename`, call `patchConnection(engine, change.connectionId, { name: change.name })` after that check.

For `disconnect`, check revision, call the existing `deleteConnection(engine, change.connectionId)`, then clean C’s usage observation:

```ts
const outcome = await publishDesktopOpencode(ports, {
    action: 'disconnect',
    workspaceId: runtime.workspaceId,
    connectionId: change.connectionId,
}, undefined, runtime.launchNonce)
if (!('ok' in outcome) || !outcome.ok) throw new DesktopHttpError(409, 'OpenCode was removed, but its usage cleanup could not be confirmed.')
```

A cleanup failure after deletion is reported as partial cleanup, not as a still-connected account or a successful complete disconnect. Existing connection release/default behavior stays with the engine.

### 4. Mount the Settings connection page

Add `workspaceId` and `onRefreshProviders` props to `DesktopSettings`, supplied by `DesktopApp` as `initialData.workspace.id` and its existing provider refresh callback. Keep the existing `providers`, `onSave`, and `onProviders` behavior for Codex and every other provider.

Use the owned loader and page only when the selected provider is `opencode`:

```tsx
const opencode = useDesktopOpencodeSnapshot(workspaceId, connection)

<DesktopOpencodeConnection
    workspaceId={workspaceId}
    connection={opencode.snapshot}
    rejected={connection?.credentialRejected}
    onSave={change => save(change, 'Settings saved.')}
    onProviders={onRefreshProviders}
    onRename={(connectionId, name, expectedConnectionRevision) =>
        save({ action: 'rename', connectionId, name, expectedConnectionRevision }, 'Connection name saved.')}
    onDisconnect={(connectionId, expectedConnectionRevision) =>
        save({ action: 'disconnect', connectionId, expectedConnectionRevision }, 'OpenCode disconnected.')}
    onBack={() => setSource(providers.default?.connectionId ?? providers.connections[0]?.id ?? 'add:openai')}
    onConnected={onRefreshProviders}
/>
```

`save` remains the existing `DesktopSettings` wrapper around `onSave`. `onRefreshProviders` must abort/sequence older reads so it cannot undo the committed Settings snapshot. No central App, board, composer or selected-tab state is passed into or changed by D.

### 5. Mount canonical default selectors

Sidebar workspace default:

```tsx
<DesktopOpencodeDefaultSelect
    connection={opencode.snapshot}
    catalog={opencode.catalog}
    modelId={providers.default?.connectionId === opencode.snapshot?.connectionId ? providers.default.model : null}
    purpose="sidebar"
    onChange={(_purpose, connectionId, model, expectedConnectionRevision) =>
        save({ action: 'default', connectionId, model, expectedConnectionRevision }, 'Default model saved.')}
/>
```

Chat, Foreman and auxiliary pickers mount the same component with `purpose="chat"`, `purpose="foreman"`, or `purpose="auxiliary"` and their existing canonical model-selection callbacks. The fourth callback argument is `expectedConnectionRevision`; those callbacks must enforce it before changing the saved selector. No selector invokes C `execute`; actual model work still begins only through the existing user-run path.

### 6. Lifecycle and restart binding

- Mount/read restores only the masked snapshot and stored catalog/usage. It never connects, probes, refreshes live catalogs, executes a model or starts provider work.
- `Refresh models` and `Refresh usage` are the only live read triggers and reuse their in-flight request IDs for retry. Their responses are fenced to workspace/connection revision.
- Save, rename, model, default and disconnect callbacks carry `expectedConnectionRevision`; root rejects stale writes. A refresh failure after a committed save is shown as a read failure, not a failed save.
- Root closes C subscriptions/readers and aborts in-flight work during workspace/runtime shutdown. D owns no native listener or long-lived socket.

## Persistence and recovery semantics

- `DESKTOP_OPENCODE_SNAPSHOT` is the bundled display fallback, not proof of current provider availability. Cached/live readings retain `capturedAt`, source and age.
- Refresh never silently replaces the selected/default model. Retired selected rows remain visible for removal only when the catalog source is `live`.
- Console remains off until the explicit plan switch adds a Console model and sets `consoleEnabled`. Turning it off cannot remove the default or final enabled model.
- Credential values are transient form input only. Snapshot responses contain `oc_sk_write_only`, never the decrypted key. Failed saves leave the form for correction and never show a connected notice.
- Closing or discarding a dirty form does not rename on input blur. Confirmations preserve committed effects and never replay a pending catalog response into a replaced connection.
- C owns catalog/usage/call persistence and replay receipts. D adds no migration and no second store.

## Implemented / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Original connection/detail flow | Implemented | Settings mount and native keyboard/responsive acceptance |
| Masked connect/edit/reconnect | Implemented | C authority, Keychain adapter and real save acceptance |
| Go/Console rows and opt-in | Implemented | C enable validation and canonical model write |
| Usage windows and age | Implemented | C usage adapter and real limits acceptance |
| Catalog refresh and retired models | Implemented | C catalog persistence and stale-response acceptance |
| Default/last-model locks | Implemented | Sidebar/chat/Foreman/auxiliary callback mounts |
| Revision/cancel/stale fencing | Implemented | Expected-revision enforcement in root Settings writes |
| Confirmed disconnect | Implemented | Engine delete plus C usage cleanup |
| Live account sign-in, spending or provider call | Unsupported in this lane | Root performs authorized acceptance only |
| Silent model replacement/fallback | Explicitly absent | Must remain absent |
| Second catalog/account/store | Explicitly absent | Must remain absent |
| Installed acceptance | Not run | Root runs all checks and repairs |

## Authored but unrun regressions

- `DesktopOpencodeModels.test.tsx`: default lock, explicit Console opt-in, Go selection, retired-row removal and cross-plan search.
- `DesktopOpencodeConnection.test.tsx`: rejected credential, failed canonical save, dirty-form Cancel/Discard, stale refresh after revision change, and failed disconnect without false completion.
- `client.test.ts`: exact C action bodies, same-origin/no-credential headers and refused-result handling.

No checks were executed. Root owns all tests, packaging and board/full-restart acceptance.

## Known limits

- C’s ports, contract barrel, provider registration, store migration and engine execution must be integrated before the UI can succeed.
- Public snapshot data is not live availability, plan entitlement or proof of a valid key. Usage is shown only as reported; no prices, totals or service availability are invented.
- The snapshot DTO intentionally carries only a write-only key marker. It cannot be used to execute a request and should not be logged as a real key.
- `expectedConnectionRevision` is optional at the shared Settings schema for other providers, but required by D’s OpenCode callbacks and must be enforced for OpenCode writes.
- Disconnect cleanup after engine deletion can be partially uncertain; the root fragment reports that rather than pretending the connection remains or cleanup completed.
- No installed Next dependency documentation was present in the prepared worktree; route files follow the base’s authenticated desktop-route idiom.
