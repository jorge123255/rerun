# Round 36 D — original API keys and external-client setup UI

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round36-external-mcp-ui`, branch `desktop/round36-external-mcp-ui`, prepared base `970415507e28824bb001f46c8537d20fd2636b1c`. Original source pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

Source handoff only. No tests, typecheck, lint, builds, installs, servers, network/provider calls, Docker, browser/native UI, microphone, Keychain or restart checks were executed. This is not installed acceptance or W4/B5 completion. Root integrates, repairs and accepts.

## Published dependent contracts

- **B / Grok Worker 2 D:** commit `9e81e11110e09aeb05266068c332b44fdee38496`, branch `desktop/round36-external-mcp-authority`, `packages/contracts/src/desktop-external-mcp.ts`, `DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION = 1`. Consumed exactly; no competing principal, key, grant, scope or receipt shape was created. B’s `docs/desktop-round36-b-handoff.md` remains the authority on key custody, listener admission and management-route activation.
- **Workspace identity:** `packages/contracts/src/desktop-workspaces.ts`, `DESKTOP_WORKSPACES_CONTRACT_VERSION = 1`, read at root integration commit `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0`. Positive numeric IDs come from the canonical selection/runtime. No second workspace catalog was created.
- B’s server adapter consumed by the owned route handlers: `apps/ui/lib/desktop/server/external-mcp-authority/client.ts` at the B commit, specifically `listDesktopExternalMcpKeys`, `createDesktopExternalMcpKey`, `revokeDesktopExternalMcpKey`, `readDesktopExternalMcpListener`, `enableDesktopExternalMcpListener`, and `disableDesktopExternalMcpListener`.
- The secret gate is B’s `externalMcpDisplayedSecret`. The durable UI attempt journal never contains a secret, key hash, engine token, listener credential or principal.

The prepared D worktree does not contain B’s files. Root must integrate B before these calls can succeed. B’s management routes are otherwise unmounted and its runtime authority may return `authority_missing`.

## Original source/design mapping

Read at the original pin:

- `apps/ui/components/dialogs/ApiKeysDialog.tsx`: original order is “Connect a client” then “Keys”; a fresh secret replaces the snippets; name input supports Enter; Create key is explicit; refresh occurs after create/revoke; closing discards the displayed secret; revoke has a separate confirmation.
- `ApiKeyList.tsx`: shared bordered rows, name/prefix, last-used/never-used copy and destructive icon action. D adds B’s scope, expiry, expired/revoked and unfinished-revoke projections.
- `CreatedApiKey.tsx`: original success Alert, “Copy this key now. It will never be shown again.”, key copy, real-secret snippets and “I copied it”. D adds Hide/Reveal without changing the one-time lifecycle. Hidden Copy still copies the real secret.
- `RevokeApiKeyDialog.tsx`: original title, destructive description, Cancel and Revoke with pending spinner and prevented default close behavior. D keeps the exact confirmation and exposes safe retry errors.
- `McpSnippets.tsx`, `McpClientPicker.tsx`, `CopyLine.tsx`, `CopyBlock.tsx`: original client order, labels, config/commands, helper text, docs links and responsive wrapping. D preserves them through local copy adapters.
- `apps/ui/lib/mcp/connect.ts`: original Claude Code, ChatGPT/Codex, Cursor, Rerun and Other snippets, Bearer authorization and `rk_your_key` placeholder. D changes only the endpoint authority to B’s loopback listener origin plus `/mcp`, never `/api/mcp/account` or the engine origin.
- `apps/ui/app/api/_actions/api-keys.actions.ts`: original 60-character names, 20 active keys and one-time cleartext response. B owns the corresponding Mac custody and cap behavior.
- `apps/ui/components/desktop/DesktopAssistantReply.tsx`: Mac external HTTPS navigation and user-activated synchronous Copy policy. D uses the same policy and `noopener noreferrer` behavior through existing DocsLink/Source components.

Intentional Mac additions: explicit read-only default scopes, optional expiry, expired/revoked state, manual listener enable/disable, durable nonsecret pending attempts, lost-ack reconciliation and per-workspace response isolation. None auto-enables the listener or expands a grant.

## Owned implementation inventory

### Renderer components — `apps/ui/components/desktop/external-mcp/`

- `DesktopExternalMcpDialog.tsx`: original dialog composition, listener controls, create name/expiry/scope form, safe errors and workspace-keyed isolation.
- `useDesktopExternalMcpController.ts`: exact workspace/generation guards, read cancellation, durable attempt reservation before effects, same-ID retry, exact response identity checks, transient secret state and refresh without form reset.
- `DesktopExternalMcpKeyList.tsx`: original row design plus scopes, expiry, expired/revoked and pending-revoke states.
- `DesktopCreatedExternalMcpKey.tsx`: original one-time success layout with Hide/Reveal and real-secret snippets only while the listener is configured.
- `DesktopExternalMcpSnippets.tsx`: original picker, snippet ordering, helper text and documentation links.
- `DesktopExternalMcpCopy.tsx`: original line/block presentation with the Mac Copy policy; all buttons are non-submit.
- `DesktopRevokeExternalMcpKeyDialog.tsx`: original destructive confirmation, Cancel, pending and retry errors.
- `DesktopExternalMcpDialog.test.tsx`: authored mounted regressions, unrun.

### Client/server adapters — `apps/ui/lib/desktop/external-mcp/`

- `driver.ts`: typed UI port using only B’s DTOs and nonsecret UI attempts.
- `client.ts`: concrete authenticated desktop-route driver with schema validation, no-store responses and workspace checks.
- `api.ts`: concrete authenticated route handlers calling B’s server functions. Create/revoke/listener bodies use B’s exact schemas. Responses validate result/receipt/workspace identity and never include the internal engine credential.
- `attempts.ts`: UI-only recovery union containing B create/revoke/enable/disable inputs. This is not another principal or grant contract.
- `attempt-store.ts`: additive canonical desktop DB journal. One slot per workspace create, per-key revoke and per-workspace listener transition; same exact attempt joins, changed input refuses, unique request IDs, exact acknowledgement deletion.
- `snippets.ts`: pure loopback endpoint validation and original client snippet generation.
- `copy.ts`: synchronous user-activated Mac plain-text Copy.
- `attempt-store.test.ts`, `snippets.test.ts`: authored regressions, unrun.

## Exact root activation fragments

No central file was edited in this lane.

### 1. Integrate B first

Apply B’s handoff at `9e81e11110e09aeb05266068c332b44fdee38496`, including its contract barrel, datadir step, management router, `desktopRouteAllowed` entries and canonical workspace runtime binding. In particular, D’s UI route handlers call B’s engine-origin management client; mounting D alone does not make that service available. B’s listener remains default-off and is never enabled by D’s import, dialog mount, refresh, snippet Copy or restart.

### 2. Add the D attempt-journal schema

In `apps/ui/lib/desktop/server/database.ts`, add:

```ts
import { ensureDesktopExternalMcpUiSchema } from '../external-mcp/attempt-store'
```

Call inside `initialize(dataRoot)` after the existing feature initializers:

```ts
await ensureDesktopExternalMcpUiSchema(client)
```

This adds only `desktop_external_mcp_ui_attempts` and its workspace index. It stores request ID, kind, workspace, exact nonsecret input and creation time. No engine datadir migration or second key database belongs to D.

### 3. Mount the authenticated desktop routes

`apps/ui/app/api/desktop/external-mcp/keys/route.ts`:

```ts
export { handleDesktopExternalMcpKeys as GET, handleDesktopExternalMcpKeys as POST } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

`apps/ui/app/api/desktop/external-mcp/keys/revoke/route.ts`:

```ts
export { handleDesktopExternalMcpRevoke as POST } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

`apps/ui/app/api/desktop/external-mcp/listener/route.ts`:

```ts
export { handleDesktopExternalMcpListener as GET } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

`apps/ui/app/api/desktop/external-mcp/listener/enable/route.ts`:

```ts
export { handleDesktopExternalMcpListenerEnable as POST } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

`apps/ui/app/api/desktop/external-mcp/listener/disable/route.ts`:

```ts
export { handleDesktopExternalMcpListenerDisable as POST } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

`apps/ui/app/api/desktop/external-mcp/attempts/route.ts`:

```ts
export { handleDesktopExternalMcpAttempts as GET, handleDesktopExternalMcpAttempts as PUT, handleDesktopExternalMcpAttempts as DELETE } from '@/lib/desktop/external-mcp/api'
export const runtime = 'nodejs'
```

These are authenticated desktop session routes, not public listener routes. B’s public-client transport remains only its loopback `/mcp` listener with its own origin/host/admission rules.

### 4. Mount the dialog in `DesktopApp.tsx`

Add the import and state:

```tsx
import { DesktopExternalMcpDialog } from './external-mcp/DesktopExternalMcpDialog'

const [externalMcpOpen, setExternalMcpOpen] = useState(false)
```

Use the existing bootstrap workspace identity; no loader change is needed because `initialData.workspace.id` is already canonical:

```tsx
const openExternalMcp = () => {
    if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setExternalMcpOpen(true)
}
```

Render beside the other workspace dialogs:

```tsx
<DesktopExternalMcpDialog
    open={externalMcpOpen}
    onOpenChange={setExternalMcpOpen}
    workspaceId={initialData.workspace.id}
/>
```

Include `externalMcpOpen` in the same board/chat inert calculations as `workspaceSettings` if root wants the dialog to suspend board interaction. The owned component itself does not read or mutate board, chat, model or draft state.

### 5. Workspace menu entry

In `DesktopWorkspaceMenu.tsx`, import `KeyRound`, add optional `onExternalMcp?: () => void`, and place this item immediately before Workspace settings:

```tsx
{onExternalMcp && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onExternalMcp() }}><KeyRound /> API keys</DropdownMenuItem>}
```

Pass `onExternalMcp={openExternalMcp}` from `DesktopApp`.

### 6. Control Center command

In `apps/ui/lib/desktop/control-center.ts`:

```ts
export const DESKTOP_CONTROL_COMMAND_IDS = ['add_coworker', 'new_box', 'shared_files', 'company_brain', 'team_board', 'model_settings', 'external_mcp', 'workspace_settings', 'recenter_board', 'toggle_theme', 'notifications', 'shortcuts'] as const

export type DesktopControlCommandOptions = {
    sharedFiles?: boolean
    brain?: boolean
    addBox?: boolean
    shortcuts?: boolean
    notifications?: boolean
    externalMcp?: boolean
    workspaceSettings?: boolean
    recenterBoard?: boolean
    toggleTheme?: boolean
    darkTheme?: boolean
}
```

Add before the Workspace settings command in `buildDesktopControlCommands`:

```ts
if (options.externalMcp) commands.push({ id: 'external_mcp', group: 'settings', label: 'API keys', keywords: ['mcp', 'client', 'claude code', 'connect', 'token'] })
```

In `DesktopControlCenter.tsx`:

- Add `onExternalMcp?: () => void` to `DesktopControlCenterProps` and the function destructuring.
- Include `onExternalMcp` in both `latest.current` initializers.
- Add `external_mcp: current.onExternalMcp` to the command action map.
- Add `externalMcp: !!onExternalMcp` to `buildDesktopControlCommands({ ... })`.
- Pass `onExternalMcp={openExternalMcp}` from `DesktopApp`.

A retained Control Center callback therefore invokes only the current root-provided opener, never a listener or key effect directly.

## Persistence, recovery and isolation semantics

- Create/reserve is durable before B is called. Retry uses the identical B input and request ID. A changed request under one ID refuses; no replay identity is evicted to repeat an effect.
- Revoke and listener enable/disable use the same reservation rule. Cancel closes only the confirmation; it does not revoke or clear an uncertain pending request.
- Network/authority uncertainty leaves the pending attempt and a retry state. A recovered create with `secretAvailable:false` shows B’s discarded-secret guidance, never an old or reconstructed secret.
- Cleartext exists only in the successful create response and transient `createdSecret`. It is not written to the attempt DB, localStorage, logs or ordinary history. Close, “I copied it”, workspace switch and stale completion remove the display.
- Refresh replaces only keys/listener observations. It does not clear the name, scope or expiry form, and it does not resurface a dismissed secret.
- Every awaited response is generation-checked. A close/reopen reconciles through the durable attempt rather than redirecting the old response. Workspace changes remount the feature and abort owned reads/mutations; previous-workspace keys cannot land in the new view.
- Create checks key name, workspace, scopes, expiry and create receipt identity. Revoke checks key ID/workspace/revision/revoked status and revoke receipt. Listener changes check receipt kind/workspace and actual listener view.
- No mount, refresh, snippet selection, Copy or restart calls enable. Only the labelled manual listener button reserves an enable/disable request.
- Board, chat, drafts, selected model, settings and permissions are outside this component’s state and effects.

## Supported / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Original list/create/secret/revoke UI | Implemented | Mounted native keyboard/responsive acceptance |
| Name, expiry and scope selection | Implemented with B schemas | B admission and real key acceptance |
| Read-only default | `mcp:read` only until explicit write selection | Root verifies no grant expansion |
| One-time secret and Copy | Implemented; no durable secret | Native Clipboard acceptance |
| Lost-ack same-ID recovery | Concrete desktop DB journal and controller | Schema initializer and restart acceptance |
| Loopback snippets | All original clients using listener origin + `/mcp` | B listener/runtime binding; no snippets while off |
| Listener opt-in/out | Explicit button with same-ID recovery | B listener management routes and native drain |
| Workspace isolation | Workspace-keyed UI and response checks | Canonical W1 lifecycle/bindings |
| Public URL, remote hosting, engine-token snippet | Unsupported | Must remain unsupported |
| Automatic listener start or grant expansion | Explicitly absent | Must remain absent |
| External tool catalog/dispatch | Not owned | C’s exact registration and B admission |
| Mac/W4/B5 acceptance | Not run | Root runs every check and repair |

## Authored but unrun regressions

- `DesktopExternalMcpDialog.test.tsx`: default read-only create, keyboard Enter, one-time secret, Hide/Reveal, no automatic listener enable, lost-create same-ID retry, discarded-secret non-display, revoke Cancel/confirm, expired state, immediate and delayed workspace switches, and lost-revoke same-ID retry.
- `attempt-store.test.ts`: nonsecret durable attempt, same-ID join, changed-input conflict and exact clear.
- `snippets.test.ts`: configured `/mcp` endpoint, listener-off/public/engine-path refusal, original commands and no hosted endpoint substitution.

No execution checks were run. All native create/revoke/listener, lost-ack, restart, keyboard and responsive acceptance remains pending root.

## Known limits

- B’s management routes, contract barrel and runtime binding are prerequisites; the UI reports their refusal/unavailability rather than faking keys or listener state.
- Snippets are for supported local MCP clients only. They do not make browser-hosted ChatGPT accept a key, create a public URL, enable CORS or provide a remote service.
- Expired keys may remain visible per B’s bounded list; revoked keys normally disappear on refresh. D renders either status if returned.
- A discarded secret cannot be recovered from B’s hash or D’s journal. The user must revoke that key and explicitly create another with a new request ID.
- If journal acknowledgement cleanup fails after a secret was displayed, a later open can recover only `secretAvailable:false`; it never replays the secret.
- C’s external tool inventory/dispatcher and sharing/billing/member features are outside D’s scope.
- Installed Next documentation was absent under the prepared worktree’s `node_modules`; route files follow the base’s existing authenticated internal-route idiom.
