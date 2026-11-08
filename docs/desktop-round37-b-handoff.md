# Round 37 B — custom provider Settings UI

Implementation SHA: `52fbba7a2c2b476385e67a4cde4352eb25e9a52e`. This document is a later commit, so that SHA is not this tip.

Branch `desktop/round37-custom-provider-ui`. Verified base `e87edabffded9b56c67f98539a412e230959435c`. Accepted runtime reference remains `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`. Round 36 lanes were not edited and are not integrated here.

**No checks executed and no installed acceptance.** No tests, typecheck, lint, build, install, server, fixture, provider or network call, Docker, browser, native UI, microphone, Keychain, or restart. Root reviews, fixes, and runs every check. The checklist line "New provider delta / Settings design" stays open. This source does not connect a provider and does not change the Codex-only connected state.

## Contract this UI binds

Agent A's implementation revision `6ebc50dc94dc437a40f0218e6804acda115e1f7f` (`Publish` parent `d98fe9ed4758775f291b28f7146a46f8326bf560` plus draft probe and strict endpoints). A's later handoff commit `9f6893da8c4d2180787833fd20989304a939c7c1` has the same contract blob (`24f7b335854f07ff00b814bdd6056a62dc627928`). Bind `6ebc50dc`, not only `d98fe9ed`.

`DESKTOP_CUSTOM_PROVIDER_VERSION` is 1. This worktree's `packages/contracts/src/index.ts` stops at `desktop-workspaces.js` and does not export the contract. UI imports will not resolve until root adds the barrel line below. Do not copy A's contract file into this lane.

## Changed files

Owned UI and client, 13 files, all under the two owned directories:

- `apps/ui/components/desktop/connections/custom/DesktopCustomProviderPage.tsx`
- `apps/ui/components/desktop/connections/custom/DesktopCustomPresetPicker.tsx`
- `apps/ui/components/desktop/connections/custom/DesktopCustomEndpointSettings.tsx`
- `apps/ui/components/desktop/connections/custom/DesktopCustomModelList.tsx`
- `apps/ui/components/desktop/connections/custom/index.ts`
- `apps/ui/components/desktop/connections/custom/DesktopCustomProviderPage.test.tsx`
- `apps/ui/lib/desktop/custom-providers/messages.ts`
- `apps/ui/lib/desktop/custom-providers/apply-probe.ts`
- `apps/ui/lib/desktop/custom-providers/client.ts`
- `apps/ui/lib/desktop/custom-providers/index.ts`
- `apps/ui/lib/desktop/custom-providers/messages.test.ts`
- `apps/ui/lib/desktop/custom-providers/apply-probe.test.ts`
- `apps/ui/lib/desktop/custom-providers/client.test.ts`

## Original source mapping

Read-only fork `2a57fa6dd53311f763bfc9abde85997b7f7e5309` in `upstream-review-20261106`. Desktop is local, so every preset is offered (`presetsFor(false)`), including Ollama. Cloud `NoPlanNotice`, `RERUN_CLOUD`, and the public-address sentence are not used.

| Original | This lane |
| --- | --- |
| `apps/ui/components/connections/custom/AddCustomProviderPage.tsx` | Add layout on `DesktopCustomProviderPage`: Server, Name, Base URL, API key, Model id only after a missing list, Connect / Connecting… |
| `CustomPresetPicker.tsx` | `DesktopCustomPresetPicker`. Value `other` when no preset. |
| `CustomEndpointSettings.tsx` | `DesktopCustomEndpointSettings` after a snapshot exists. Blur keeps the edit local. |
| `CustomModelList.tsx`, upstream model buckets, search, retired sentence | `DesktopCustomModelList` |
| `custom-endpoint.ts` `MODELS_ON_AT_CONNECT` and local probe sentences | `messages.ts` / `apply-probe.ts` |
| Connection delete | Not `DeleteConnectionButton`. Disconnect stays on this connection and does not pick a replacement. |

Copy kept from the original: header `Custom endpoint`; hint `Ollama, LM Studio, vLLM or any OpenAI-compatible server`; name helper `Shown in every coworker's model picker`; Base URL placeholder `https://your-server.com/v1`; key placeholder `Paste your key` or `None for a local server`; model placeholder `llama3.3:70b`; default sentence `This becomes the workspace default: every coworker with no model of its own will run on it.`; back `aria-label="Back to AI providers"`; buckets `Your coworkers can use` / `Turned off`; locks `This is the default model. Pick another default first.` and `Coworkers need at least one model from this source.`; retired sentence from `DesktopModelSelector`; search `Search models` and `No model matches “…”`.

The header is reimplemented because `ProviderHeader` requires `AddableProvider`, which excludes `custom`. `SourceBits.tsx` was not edited.

## What the page does

`DesktopCustomProviderPage` takes `workspaceId`, optional `identity`, `takenNames`, `defaultModel`, `willBecomeBoxDefault`, optional `adapter`, `onBack`, `returnFocusId`, and `onReceipt`. The default adapter is `createDesktopCustomProviderClient()` posting to `/api/desktop/custom-providers`.

Connect on a new provider calls `probe_draft` first. A missing list sets the Model id field and does not create a connection. A usable typed model is saved as one `source: 'manual'` row. A fresh list saves the first 10, with a usable typed id first when it was sent. An unavailable list is never copied into `config.models` or shown as a discovered catalog. `not_listed` does not set `state` to `disconnected`.

Create, update, and disconnect use A's change schema. The same `requestId` is kept until the receipt is `recorded`. An edited save is refused with `Saved, waiting to confirm the receipt.` until that receipt resolves. Retry resends the held change, not the edited fields. A recorded read replaces the form. `onReceipt` is informational and is not called when `change` fails.

A saved probe is dropped when the generation, workspace, connection, revision, or base URL does not match. A dirty base URL shows `Save the endpoint before checking it again.` The password field is always empty. `configuredSecret` only changes the helper to `Saved keys stay hidden.` A typed key is `apiKey`. Clear is `clearSecret: true` and never both. Remount calls `read` and does not probe. Codex reasoning controls are not on this page.

## Root activation fragments

Do not mount this UI against an in-memory authority or the old `.env` writer. A's `CustomProviderAuthority` is still the missing secure connection owner. Until that owner, the provider enum, and this route exist, Settings must show the capability unavailable rather than save a connection that cannot run.

Barrel, from A's `6ebc50dc` file:

```ts
export * from './desktop-custom-provider.js'
```

Route, only after A's committed `createDesktopCustomProviderApi` and the secure authority exist. Same authority instance inference uses. `customApi.close()` on shutdown.

```ts
import { createDesktopCustomProviderApi } from '@/lib/desktop/server/custom-providers'
const customApi = createDesktopCustomProviderApi(secureConnectionAuthority)
export function POST(request: Request) {
    return desktopRoute(request, runtime => customApi.request(runtime, request))
}
```

Proposed file: `apps/ui/app/api/desktop/custom-providers/route.ts`. POST only, through `desktopRoute`. No second registry.

Settings mount, inside the existing AI providers pane so `DesktopBoard` and `DesktopConversation` stay mounted. Do not edit this lane's shell to do it.

```tsx
{source === 'custom' ? (
    <DesktopCustomProviderPage
        workspaceId={runtime.workspaceId}
        identity={savedIdentity}
        takenNames={providers.connections.map(connection => connection.name)}
        defaultModel={providers.default}
        willBecomeBoxDefault={!providers.default}
        returnFocusId="desktop-provider"
        onBack={() => { setSource(previousSource); }}
        onReceipt={() => { /* do not call setBoxDefault and do not relabel the sidebar */ }}
    />
) : null}
```

`onBack` focuses `#desktop-provider` inside the page. Keep the Codex block at `DesktopSettings.tsx` `#desktop-reasoning-effort`. Do not send a custom endpoint through `changeDesktopSettings` (`Only OpenRouter supports a custom endpoint.`). Add `'custom'` once to `providerSchema`, `CONNECTION_TOKEN_KEY`, `PROVIDER_LABELS` (`Custom`), `PROVIDER_PITCH`, and `desktopProvider` together. Until then `chat-model.ts` hides a custom connection. A failed default write must not change the sidebar label. Disconnect must not select another provider.

`apps/ui/lib/desktop/server/auth.ts` does not list `/api/desktop/custom-providers` on the frozen-workspace draft allowlist. A switch returns 409 `This workspace is switching. Wait for it to finish.` Leave that path off the allowlist unless root wants the form during a switch.

No migration from this lane. If the secure authority needs a datadir id, root appends the next free integer. Do not reuse a Round 36 id.

## Implemented / dependent / unsupported

| Area | Status |
| --- | --- |
| Preset, endpoint, probe, model list, save, cancel, discard, disconnect UI | Implemented source, unrun |
| `probe_draft` then create, then read and saved probe | Implemented against A's published request. Draft result has no published schema; the client accepts only the fields `probeCustomDraft` returns |
| Masked key, stale probe, manual versus discovered, workspace switch | Implemented source, unrun |
| Contracts barrel, provider enum, Settings mount, route | Dependent. Root-owned. Not edited here |
| Secure revision, encrypted key, receipt ledger | Dependent. A's authority is not in this base. Do not substitute `.env` or an in-memory store |
| Pre-create probe without `probe_draft` | Unsupported. The first Connect calls `probe_draft` |
| Cloud plan notice, Supabase, Docker host rewrite, revealing a saved key | Unsupported |
| Changing Codex reasoning, or selecting another provider on cancel or disconnect | Unsupported |
| Live endpoint or account from this lane | Unsupported. None was contacted |

## Limitations

- Client and page tests import `@rerun/contracts` names that this branch does not export. They cannot load until root exports A's contract.
- A private hostname that is not loopback or an IP literal is not marked `allowPrivate`. Loopback and literal IPs are, because the submitted URL is the review. The preset id does not grant the flag.
- A workspace switch drops local replay ids. A receipt left in the previous workspace is not replayed after the switch.
- `onReceipt` runs before the saved probe. If the parent passes the new identity back, the read effect can reload that snapshot while the probe is still in flight. The probe is dropped unless the identity still matches.
- An edited form does not start a new request while a receipt is unresolved. Retry resends the held body. Restoring the fields is not required for that retry, and a recorded read replaces the edit.
- Two overlapping creates from two mounted pages are not serialized. One page keeps a single held request.
- Empty discovery (`status: 'empty'`) asks for a model id because create requires at least one model. It does not invent a catalog.
- Narrow and short-window classes are in the source (`min-h-0`, `overflow-y-auto`, `flex-wrap`, `break-words`). Root does the desktop, narrow, and short-window rendering. This lane did not open a UI or screenshot tool.

No checks executed and no installed acceptance.
