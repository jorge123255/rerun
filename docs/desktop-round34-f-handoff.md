# Round 34 F — Claude subscription sign-in and connection settings UI

Source implementation and mounted regression sources only. Root owns settings/provider dispatch, native browser opening, Keychain, provider programs, backend/native runner and every execution check. No sign-in, credential access or installed-app acceptance was performed.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/connections/plan-connect/ClaudePlanSteps.tsx`: `Approve Rerun on Claude`, Open/Open again, `Paste the code`, masked code field, direct-paste exchange, checking/connected/error states and step remarks.
- `apps/ui/components/connections/plan-connect/PlanConnect.tsx`: provider dispatch and `onKeys`/final-step integration. Root must keep existing ChatGPT/API-key paths; this lane does not substitute another flow.
- `apps/ui/components/connections/plan-connect/ForemanTrack.tsx`: three-step layout, Orb position, connecting line and step status. Reused unchanged.
- `apps/ui/components/connections/plan-connect/NameStep.tsx`: `Name it`, connection-name placeholder, Done and model-picker explanation. Reused unchanged.
- `apps/ui/components/connections/plan-connect/step-bits.tsx`: original error presentation.
- `apps/ui/components/connections/use-claude-oauth.ts`: idle/waiting/checking/connected transitions, trimmed code, immediate paste exchange, Open lock and stale PKCE refusal. Desktop attempts use runtime-provided durable IDs and generation guards instead of UI-only PKCE state.
- `apps/ui/components/connections/ConnectionDetail.tsx`: connected/expired/rejected presentation, reconnect and runtime model choices.
- `apps/ui/components/connections/DeleteConnectionButton.tsx`: removal only from details and explicit `Remove …?` confirmation.

The local dialog is compact and responsive: `max-h-[85dvh]`, narrow-screen width cap and internal vertical scrolling. Browser opening happens only after an explicit Open click and only through root’s validated native callback. No Mac password, provider password or API-key form is introduced.

## Canonical UI/runtime callback contract

`apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.ts` exports the only owned auth interface:

```ts
type DesktopClaudePlanPhase = 'idle' | 'waiting' | 'checking' | 'connected' | 'error'
type DesktopClaudePlanAttempt = {
    attemptId: string
    phase: DesktopClaudePlanPhase
    authorizeUrl?: string
    error?: string
}
type DesktopClaudePlanRuntime = {
    start: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    reconcile: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    submit: (attemptId: string, code: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    cancel: (attemptId: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
}
```

G owns this backend contract and all OAuth/Keychain behavior. Its worktree did not yet expose a Claude contract when this was written; the interface above is the required integration surface, not a second authentication store.

Runtime expectations:

- `attemptId` is an opaque durable identity for one current pending login. Start/reconcile returns the same pending attempt across reopen/restart and never creates a second login for repeated clicks.
- `authorizeUrl` comes only from G’s validated sign-in runtime. The UI additionally requires HTTPS, no credentials/fragment and default HTTPS port before calling `onOpenAuthorization`.
- `submit` exchanges the code or handles an original `claude setup-token` value as G decides. The hook trims input like the original, but never stores/logs it. API-key fallback is not implemented here.
- `cancel` closes only the pending UI attempt. It must not delete/disconnect an existing usable login.
- `connected` is returned only after G has durably saved and authenticated the exact connection. Error/unknown/expired results remain non-connected and retryable.

The hook guards same-render clicks with refs, aborts superseded calls and ignores stale responses by generation/attempt. Mount reconciliation is read-only and never opens a browser.

## Components and root mounting

### Provider connection flow

Render `DesktopClaudePlanSteps` only for Claude; keep existing ChatGPT and API-key dispatch unchanged:

```tsx
<DesktopClaudePlanSteps
    runtime={claudeRuntime}
    onOpenAuthorization={url => openNativeAuthorization(url)}
    onDone={name => saveOrRenameClaudeConnection(name)}
/>
```

`lastStep` is optional for reconnect/custom final steps; `initialName` defaults to `Claude`. `DesktopClaudePlanDialog` wraps the same steps with title/description and root’s `open/onOpenChange` state. Closing runs read-only reconcile and cancels only a non-idle/non-connected pending attempt.

### Connection details

```tsx
<DesktopClaudeConnectionDetails
    connection={selectedClaudeConnection}
    account={{ label: accountEmail, unavailable: keychainUnavailable }}
    defaultModel={workspaceDefaultModel}
    runtime={claudeRuntime}
    onOpenAuthorization={openNativeAuthorization}
    onModelsChange={models => saveConnectionModels(selectedClaudeConnection.id, models)}
    onDisconnect={id => disconnectExistingConnection(id)}
    onBack={closeDetails}
/>
```

Root supplies account metadata, runtime/catalog model lists and all model mutations. The component does not infer subscription entitlement or model availability. `ModelBuckets` is reused unchanged.

States are explicit: Connected, Sign-in expired, Sign-in rejected and Connection unavailable. Reconnect uses the same original three-step flow and does not clear the existing account on Keychain/runtime errors. Removal is always an explicit `Remove <name>?` confirmation, not a side effect of Cancel/Escape.

## Durable/restart/cancel/error behavior

- Reopen calls `reconcile` on mount without browser opening or login creation. G returns the same opaque attempt.
- Repeated Open clicks share one immediate ref lock and one durable runtime attempt. Repeated exchanges/Continue actions ignore stale responses.
- A stale submit cannot overwrite a newer attempt or a Cancel result. A failed exchange leaves the code step retryable.
- Closing the dialog cancels only a pending UI operation. It does not remove a connected account or alter workspace/coworker model choices.
- Existing API-key/ChatGPT connections and saved model choices remain root-owned and untouched.
- Keychain/unavailable errors use actionable text while retaining the current login until root explicitly disconnects it.
- Root must surface G’s unavailable/unsupported backend as an error, not as a successful connection.

## Implemented / dependent / unsupported matrix

| Area | Implemented in lane | Root/G dependency | Unsupported here |
| --- | --- | --- | --- |
| Original steps | Open, code, Name it, errors and layout | Runtime exchange and connection save | New provider flow |
| Attempt lifecycle | Durable-ID callbacks, ref locks, stale guards, reconcile | Opaque durable attempt authority | UI-only PKCE/auth store |
| Browser opening | Explicit validated HTTPS destination | Native browser dispatch | Arbitrary/model URLs or auto-open |
| Details | Account state, metadata, reconnect, catalog models | Account/catalog/model adapters | Guessed entitlements |
| Removal | Explicit confirmation and error state | Existing disconnect implementation | Disconnect on Cancel/Escape |
| Dialog | Compact responsive content and Escape cancel | Settings open/close state | Native focus QA |
| Verification | Mounted UI/client regressions | Run all checks and provider/restart QA | Live sign-in or acceptance |

## Regression sources authored, all unrun

- `apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.test.tsx`: duplicate Open, restart reconciliation, stale submit, Cancel and invalid destination.
- `apps/ui/components/desktop/claude-plan/DesktopClaudePlanSteps.test.tsx`: original steps, direct paste, retry, Name it and Escape cancel-only-pending.
- `apps/ui/components/desktop/claude-plan/DesktopClaudeConnectionDetails.test.tsx`: connected account/models, explicit removal confirmation, expired/rejected/unavailable states.

No tests, typecheck, lint, builds, installs, servers, provider calls, UI actions, Docker, Keychain, live data or restart acceptance were performed. Installed Next.js guides under `node_modules/next/dist/docs` are absent in this checkout; no installation was attempted.

## Changed files

- `apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.ts`
- `apps/ui/lib/desktop/claude-plan-client/use-desktop-claude-plan.test.tsx`
- `apps/ui/components/desktop/claude-plan/DesktopClaudePlanSteps.tsx`
- `apps/ui/components/desktop/claude-plan/DesktopClaudePlanSteps.test.tsx`
- `apps/ui/components/desktop/claude-plan/DesktopClaudeConnectionDetails.tsx`
- `apps/ui/components/desktop/claude-plan/DesktopClaudeConnectionDetails.test.tsx`
- `apps/ui/components/desktop/claude-plan/DesktopClaudePlanDialog.tsx`
- `docs/desktop-round34-f-handoff.md`
