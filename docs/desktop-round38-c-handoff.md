# RD38 C — Control Center command/context parity

Implementation commit: `07e154378f93f876a9178c63a3ea31c180ee18e5`.
Branch `desktop/round38-c-control-center`; prepared base `6f6ad959a09abaf1947950b6f82413c94407e22a` was verified with clean status before the first edits. Work was then explicitly interrupted by the I assignment; only this agent's five known source changes were preserved. On resumption the same branch/HEAD and those known owned edits were inspected before continuing. No reset/clean/rebase/branch switch/cherry-pick or changes to other trees. Handoff committed separately from implementation; final tip is reported outside this document.

**Source and authored regressions only. All execution checks NOT run:** tests, typecheck, lint, builds, installs, UI/browser, network/provider requests, native or restart/account operations. No live app data/credentials/Keychain, EE source, listener activation, hooks bypass, push, PR or publication. Root reviews, repairs and executes all checks. This source delivery is not Mac acceptance and does not close B5.

## Sources and current-reference mapping

Original read-only checkout HEAD verified at `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `apps/ui/components/control-center/ControlCenter.tsx`: actual command callers, original root/agent/Box/move pages, Needs you/Recent, conversation search, assistant row, original Desktop and scoped Notifications, move destination permission filtering.
- `apps/ui/components/control-center/ControlCenterView.tsx`: the existing dialog, grouping, icons, input/list spacing, anchored/centered variants, disabled explanations, Tab/right drill, left/back navigation, modifier-Enter Ask, selection reset and focus behavior.
- `apps/ui/lib/control-center/commands.ts`: exact global IDs, labels, order and feature/admin gates. This current pin adds `workspaceAdmin`; historical earlier copies are not a source of hosted/admin authority.
- `apps/ui/lib/control-center/search.ts`: prefix and ranking helpers.
- `apps/ui/stores/control-center.store.ts`: original open/toggle and five-recent-agent state. Hosted original localStorage is not copied over the Mac's durable per-workspace recent store.
- `apps/ui/components/agent/agent-tabs.tsx`: rail ordering/copy reused by local commands.

Current Mac read: `DesktopControlCenter.tsx`, owned `control-center-parity/**`, root-owned `lib/desktop/control-center-parity/{types,commands,snapshot,authority,adapter,controller}.ts`, `lib/desktop/control-center.ts`, `DesktopApp.tsx`, `foreman-client/runtime-client.ts`, current Foreman command handling and authenticated agent/spaces routes. Existing shared components and root-owned files were read only.

Read applicable CLAUDE, UI AGENTS/CLAUDE, assignment standard, parity checklist, upstream review, RD36 received ledger, RD37 plan and committed Round34 H handoff. Historical unchecked B5 is not evidence that accepted navigation/panels are missing. Installed Next guide was absent in both `node_modules/next/dist/docs` and `apps/ui/node_modules/next/dist/docs`; no Next API or dependency introduced.

Relevant committed lineage: Round34 original parity handoff source is recorded in `docs/desktop-round34-h-handoff.md`; authoritative integrated dependency for this package is the exact prepared base above, not the old detached lane. RD36 received B/C/D remote MCP source tips and G/H remote machine tips remain recorded in `docs/desktop-round36-received.md`; this package neither activates those services nor assumes that receiving source means acceptance. No new paired contract or provider change is needed.

## Original versus Mac command matrix

Order below is the actual original global order, not a newly invented registry.

| Original ID / label | Mac source at base | RD38 disposition |
| --- | --- | --- |
| new_agent / New agent | Existing Add coworker callback and actual create flow | Concrete copy gap: row now uses original label, same ID/callback; root pre-search fragment below |
| browse_templates / Browse templates | Already mounted through supplied canonical library callback | Preserve; tighten workspace/selection read fencing |
| new_box / New Box | Already implemented canonical Box create dialog | Preserve, no second create operation |
| ask_assistant / Ask the assistant | Already mounted exact-chat Foreman; text query produces Ask Rerun last in Assistant | Preserve canonical send/receipt authority, tighten workspace-bound Foreman lookup |
| contact_support / Contact Support | No local hosted support authority | Omitted; no outbound support message or Crisp activation |
| recenter_board / Recenter the board | Already present explicit camera callback | Preserve; only deliberate recenter may change camera |
| toggle_theme / Switch to light/dark theme | Already durable current appearance callback | Preserve original dynamic copy |
| workspace / Workspace settings | Already implemented local name/logo dialog | Preserve single-user owner authority; no invented hosted admin roles |
| members / Members | No local team/member authority | Omitted; product scope decision |
| billing / Billing | Hosted feature/paid authority absent | Omitted; no paid-upgrade pretend flow |
| ai_providers / AI providers | Existing Model settings callback and real settings dialog | Concrete label gap: original label now, same callback; no provider registration touched |
| api_keys / API keys & MCP | Existing optional local external-MCP settings opener | Preserve only when bound; opening does not create a key/listener or imply tools ready |
| company_brain / Company Brain | Existing canonical Brain dialog | Preserve original Settings grouping/order already handled by root semantic merge |
| shared_files / Shared files | Existing canonical Shared files dialog | Preserve; no upload/write/import effect on opening |
| account / Account | No local hosted-account authority | Omitted, no synthetic account editor |
| notifications / Notifications | Existing global/scoped preferences callbacks | Preserve exact scope without creating a rule |
| shortcuts / Keyboard shortcuts | Existing original-style supported-shortcuts dialog | Preserve; no additional global keyboard listener |
| whats_new / What's new | No bound current local changelog authority | Omit until root supplies real content/opener; not a fake empty panel |
| Mac extra: Team board | Existing supported board navigation | Preserve addition and canonical callback; no new camera write |
| Workspace-menu/Mac extra: Servers | Already present when callback is bound; originally bypassed async revalidation | Concrete guard gap: one bounded fresh read, deny stale/unknown/disabled scope, no double invocation |

| Context | Original source behavior | Current Mac / disposition |
| --- | --- | --- |
| Root / empty query | Needs you, Recent or Agents, Actions, Settings | Already implemented; per-workspace Mac recent persistence retained |
| Root search / @ | Agent hits, Box drill, saved conversation results; scoped agent search | Already implemented; no new result cache or name-based target fallback |
| Root search / commands | Actions/Settings, original filtering | Preserve; root must normalize labels/keywords before its pre-filter as shown below |
| Box drill | Agents belonging to exact Box, search and drill | Already implemented exact Box membership/revision checks; no Rename/Delete rows in original palette |
| Coworker Open | Original rail order: Chat, To handle, Apps, MCP, Skills, Database, Knowledge, Files, Routines, Triggers, Capabilities, Monitoring, Logs, Install, Settings as available | Existing Mac local tabs/setup/actions handlers; To handle gated by real pending state. No duplicated panels |
| Coworker Actions | Desktop; Move to another Box; Notifications | Already implemented and exact-targeted. Disabled coworker cannot open its screen; full destination Box retains its reason |
| Move drill | Other manageable Boxes, exact selected owner | Already implemented; single-user Mac workspace has no hosted team role model. Do not infer managed destinations from imported metadata |
| Open chats | Original conversation navigation plus Mac persisted open-tab list | Already implemented exact tab UID + nullable session; unsent tabs stay unsent, no new chat on inspection |
| Saved chats | Existing search result exact agent/session | Already implemented; no same-title fallback, no unsolicited send/mark-read/delete |
| File context | Original global Shared files and coworker Open → Files only | Already implemented. No original per-file Rename/Delete/Move palette commands; those belong to the real file UI. Do not invent them |

## Findings classification

**Already implemented:** root and contextual catalog construction, Box/member/move flows, exact chat selection, tab/draft restoration, rail panels, notifications, templates, Ask Foreman, shared files, recenter/theme/workspace settings, supported shortcut dialog, recent persistence. Source present or acceptance recorded is not reallocated work.

**Concrete missing code addressed:** implicit workspace-one fallback in additive command snapshot; Foreman discovery not keyed to workspace; Servers direct callback lacked an asynchronous authority refresh; global Mac alias labels differed from the current original. Added no domain action that lacks a real callback.

**Root verification/configuration:** runtime identity/nonce delivery, native/provider/remote feature readiness, complete pre-search label matching, server-side scoped response provenance, full mounted/native/restart regression execution. Existing GET agents route performs canonical pending-operation reconciliation; this package does not add a new operation, but root must review that route's observational semantics if it requires a strictly side-effect-free palette snapshot.

**Product decision:** hosted account/member/billing/support/changelog parity; whether to expose any new per-file palette action not present in original. No such capability is advertised.

## Changed files

All within assigned ownership:

- `apps/ui/components/desktop/control-center-parity/context.ts`: exact scope/workspace/optional launch nonce/board revision comparison; rejects closed, disabled, quitting or unknown workspace context.
- `.../labels.ts`: original command metadata/label projection by existing semantic ID, no callback replacement or new registry.
- `.../useDesktopControlParity.ts`: workspace-bound lifecycle/read fencing; no default workspace; optional runtime nonce; abort/deadline handling; Servers serialization/revalidation; original labels after semantic merge.
- `.../context.test.ts`: authored unit scenarios.
- `.../production.test.tsx`: authored mounted stale/denied/one-dispatch/draft-preservation scenarios; fixtures now supply real workspace ID.
- `.../DesktopControlCenterParityView.test.tsx`: authored denied Files row selection/drill scenario.
- `docs/desktop-round38-c-handoff.md`: this handoff.

## Behavior, preservation and cancellation

`DesktopParityCallbacks` retains all existing callbacks and adds only optional `runtimeLaunchNonce?:string`, copied from root's trusted runtime identity. `controlContextKey` captures runtime workspace, optional nonce, palette selection scope (root already includes open cycle/page/query) and board revision. A context change aborts pending Servers reads before any callback; rendering a new workspace filters an old Foreman ref immediately instead of waiting for effect cleanup. Unknown workspace never becomes workspace 1.

The real shared `createParityActions` and controller remain authoritative for additive command targets. Existing chat/Box/navigation guards remain in the central component. Servers now uses the same fresh authenticated agent/spaces/Foreman reads with a 15-second deadline; it checks returned snapshot workspace/revision and current availability before invoking its **existing synchronous settings-opening** callback once. Its callback opens a panel, never pairs or contacts a remote host. Root callback types remain `() => void`; an async effect must not be silently placed behind a void navigation callback.

Busy state flows through the existing parity view, disabling both selection and keyboard drill. Unknown Servers workspace has a visible disabled reason; stale/failing refresh keeps the palette open with a fixed retry notice. Existing disabled reasons survive label normalization. Callback IDs, passed agent/session IDs, chat names, Markdown, recent ordering, board state and drafts are untouched.

No durable send journal was added. Current `foreman-client/runtime-client.ts:sendMessage` already reserves `pendingSend.requestId` durably, rejects changed text/model during recovery, reuses exact pending identity and clears it only after canonical acknowledgement. Palette callbacks preserve that path; they never send on mount/search/history/reopen or automatically replay after cancellation. The shared controller's one-operation guard prevents duplicate selection while active. Cancellation cannot claim a committed send rolled back; root's exact request recovery remains authoritative. An abandoned local shadow uncertainty ledger was deliberately not retained because it would duplicate that authority and block legitimate recovery.

## Exact root fragments — not applied

The existing central component already mounts this package:

```tsx
const parity = useDesktopControlParity(/* existing inputs */)
// Existing single DesktopControlCenterParityView:
<DesktopControlCenterParityView busy={parity.state.busy} notice={parity.state.notice}
  /* existing focus/keyboard/query/page props */ sections={parity.merge(sections())} />
```

Do not mount another overlay, keyboard hook, recents store or search controller.

### 1. Forward current runtime identity

Current `server/settings.ts` bootstrap returns `runtimeWorkspaceId:runtime.workspaceId`. Root may add the public identity nonce alongside it (never engine keys/session tokens):

```ts
runtimeLaunchNonce: runtime.launchNonce
```

Extend root's initial-data DTO and current runtime-identity update path with that nonce. In `DesktopApp` pass it to the existing Control Center. In `DesktopControlCenter` destructure and forward it into the existing hook call:

```tsx
// New OPTIONAL DesktopParityCallbacks field, already supplied by this package:
runtimeLaunchNonce?: string
// Root's existing hook call:
useDesktopControlParity({ /* unchanged inputs */, runtimeWorkspaceId, runtimeLaunchNonce })
```

Workspace ID must come from canonical authenticated bootstrap, not a renderer fallback. On runtime replacement, update nonce/ID atomically or remount the root palette owner; do not let retained callbacks see a new runtime under an old identity. Without nonce forwarding, workspace/page/board/open fencing works, but same-workspace same-revision runtime-replacement fencing remains a root integration limit. This optional field is not a second runtime identity authority.

### 2. Apply original labels BEFORE central search filtering

The owned post-merge projection changes visible rows without touching callbacks. Root currently filters `buildDesktopControlCommands` before passing rows to the package, so root must also normalize those command descriptors before its `searchItems` call to make full original label/keyword queries searchable:

```ts
import { originalControlCommand } from './control-center-parity/labels'
const commands = buildDesktopControlCommands(existingOptions).map(local => {
  const original = originalControlCommand(`command-${local.id}`, darkTheme)
  return original ? {
    ...local,
    label: original.label,
    keywords: [...new Set([...local.keywords, ...original.keywords])],
  } : local
})
```

Keep the existing command row/callback mapping, IDs and gates. Do not copy `paid` or hosted admin capability from metadata into local authority. This helper reads the existing original catalog; it is not another registry. No root file was edited here. The after-filter projection alone cannot recover a row the central pre-filter already excluded; root must apply this fragment for complete new-label search parity.

### 3. Preserve original keyboard and root-owned state

Continue existing `useDesktopControlCenterKeys`, `ControlCenterView`, command list/prefix parser, focus-return policy and closed-scope guards exactly once. Retain current selected tab, actual open-chat state, unsent draft and board node/camera. Only explicit existing recenter/Team board callbacks perform their intended navigation. No persistence migration or schema export is needed for these component-only changes; there is no new on-disk state.

Existing agent/spaces response bodies do not carry an independent runtime nonce. Root's canonical authenticated transport must remain bound to the same runtime while these reads run. Strong cross-process provenance requires root to expose/verify that identity on the established boundary; this package does not pretend that adding a renderer nonce invents server-side proof.

## Authored regression inventory — all unrun

- Original global labels, dynamic theme copy and preserved disabled explanations.
- Callback/row IDs and unknown Team board/chat/user labels remain unchanged.
- Context rejection for workspace, nonce, board revision, query/page, closed/disabled/quitting and unknown runtime.
- Pending template read cannot open into another workspace with an identical board revision.
- Double-click Servers performs one fresh read; denial/close after await prevents navigation.
- Existing real settings callback executes once; unrelated mounted Markdown draft, textarea identity and selection remain unchanged; no conversation/board callback fires.
- Denied Files row cannot select or keyboard-drill; reason stays visible.
- Existing mounted parity sources still cover templates, external-MCP opener, busy state, cancellation and stale selection; these were not executed.

## Risks and limits

No native visual/short-window/keyboard/restart check was run. Reuses existing shared layout/spacing/icons rather than rewriting them. Strong runtime nonce fencing and pre-filter metadata are root mount fragments above. Existing supported domain actions and their review/permission gates were not replaced. Hosted/team/remote functions without real authority stay omitted/unavailable; an opener does not claim backend readiness. Source GET reconciliation behavior and durable Foreman cancellation recovery remain root verification responsibilities. No work in A/B, provider registries, RD37 or the I tree was performed during this resumed C assignment.

## Proposed draft PR — not published

Title: `Preserve original Control Center labels and fence stale workspace navigation`

Body: Align existing Control Center global row labels with the reviewed original while preserving canonical callbacks and state. Fence additive navigation by current workspace/selection/revision, key Foreman discovery to workspace, and revalidate/serialize Servers opening before dispatch. Existing Box/chat/file panel actions and durable Foreman recovery remain their current authorities. Includes authored but unrun stale-context, denied-access, duplicate-selection and draft-preservation regressions. Root must forward runtime nonce and apply the provided pre-search label metadata fragment. No execution checks or installed acceptance performed.
