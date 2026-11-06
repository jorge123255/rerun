# Round 34 H — Control Center contextual parity

Source handoff only. No tests/checks/native UI/restart acceptance executed. No shared checklist change.

Verified prepared clean worktree/branch `round34-control-center-parity` / `desktop/round34-control-center-parity` at exact base `d3d952ed8ac129587b3b10949cffef1a6e7982bb`. Preserved H33 Foreman presentation unchanged. User identifies installed accepted build `40aa370` (`40aa370b235e088fc3d603ecc174fc0f3d8d3ec8` exists in local Git); source inspection is not independent installed acceptance. Root coding tree was read only for current `DesktopApp`/workspace-menu adapter context and was never edited.

Read root CLAUDE.md, apps/ui AGENTS.md/CLAUDE.md, assignment standard and local parity checklist. No applicable hS.md appeared in the source inventory. Installed Next.js guides were absent at lane `node_modules/next/dist/docs` and `apps/ui/node_modules/next/dist/docs`. No install or external lookup was performed. New components are client-only adapters and use no Next-specific API; root must verify installed-version conventions during integration.

## Exact original references

Actual pinned code read with git show at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/control-center/ControlCenter.tsx`: root/agent/Box/move stack, command construction, Needs you/Recent, conversation selection, Open rail, Desktop, Move to another Box, Notifications, assistant query row last.
- `apps/ui/components/control-center/ControlCenterView.tsx`, `types.ts`: original dialog, row/icon/badge/disabled-reason layout, Tab/right-arrow drill, Enter selection, modifier-Enter assistant, Backspace/left-arrow Back, crumbs and StepTransition. Actual view is reused, not copied or redesigned.
- `apps/ui/components/control-center/useConversationSearch.ts`: 250ms search debounce, scoped results, no conversation creation, rejection of stale owner answers.
- `apps/ui/lib/control-center/commands.ts`: exact 18 global IDs, order, groups, labels, keyword lists and original visibility/gate rules. New builder calls this real source rather than duplicating a list of copy.
- `apps/ui/components/agent/agent-tabs.ts` and `apps/ui/lib/board/types.ts`: all 15 rail tabs, exact order/labels/descriptions/icons. New builder reads the actual rail definitions.
- `apps/ui/components/builder/BoardContextMenu.tsx`: adjacent coworker and Box menu scope/confirmations, not additional Control Center rows.
- `apps/ui/components/layout/WorkspaceSwitcher.tsx`: adjacent workspace menu scope, hosted workspace/account/template/admin features and existing panel entry points.
- `apps/ui/components/agent/sheet/AgentChatsList.tsx`: adjacent chat list, New chat, filters, history, Mark all as read confirmation. These are not original Control Center commands.

Compared accepted-source `40aa370` and lane source `DesktopControlCenter.tsx`, `lib/desktop/control-center.ts`, `coworker-panel.ts`, persisted chat reader/hooks, workspace menu and current root DesktopApp bindings. Read I33 `round33-foreman-runtime/packages/contracts/src/desktop-foreman.ts` read-only (version 1, exact `{workspaceId,chatId}` identity). No contract copied. New source consumes the unchanged H33 identity adapter; root must switch it to I's canonical export when available, as H33 already documents. This package adds no Foreman durable/runtime types.

## Global inventory (original order)

“Present” below means existing Mac source/recorded checklist capability; native acceptance remains root's decision. No installed app was inspected.

| Original ID / label | Mac mapping and disposition |
| --- | --- |
| new_agent / New agent | Present as Add coworker. Existing workflow/label retained by semantic merge; no duplicate New agent row. |
| browse_templates / Browse templates | Missing from Control Center builder. Workspace templates source exists; new row uses injected canonical template opener only when root marks it ready. |
| new_box / New Box | Present; existing authoritative Box creation flow retained. |
| ask_assistant / Ask the assistant | Missing from builder. H33/I33 source dependency under root review; omitted without exact existing ready Foreman chat. With text, original Ask Rerun row remains last in Assistant. |
| contact_support / Contact Support | Original support feature flag; hosted Crisp/external messaging omitted. No local substitute. |
| recenter_board / Recenter the board | Present. Explicit recenter is the only command intended to recenter the board. |
| toggle_theme / Switch to light/dark theme | Present; resolved-theme label preserved. |
| workspace / Workspace settings | Present; existing dialog/atomic Save/Cancel/confirmations retained. |
| members / Members | Hosted workspace membership/invites omitted. |
| billing / Billing | Hosted billing flag/plan flow omitted. |
| ai_providers / AI providers | Present as Model settings; semantic alias retains existing callback/label. |
| api_keys / API keys & MCP | Hosted workspace API entitlement/paid gate omitted. Local coworker MCP is a separate existing panel, not an alias. |
| company_brain / Company Brain | Present; original Settings grouping restored by merge, same local opener. |
| shared_files / Shared files | Present; original Settings grouping restored, same local opener. |
| account / Account | Hosted profile/auth omitted; not repurposed as model settings. |
| notifications / Notifications | Present; existing global preferences opener, no rule creation. |
| shortcuts / Keyboard shortcuts | Present; existing working shortcut table remains root-owned. |
| whats_new / What's new | Original hasChangelog gate. No supplied canonical local changelog handler in inspected DesktopApp; omitted unless root supplies a real ready handler plus hasChangelog. |

Mac-only Team board remains an existing extension. It is retained, not duplicated or turned into another original command. Existing commands are semantically deduplicated despite renamed Mac IDs. Original globals are sorted by original order, and Company Brain/Shared files use their original Settings group; unknown local extensions retain stable relative order after known rows. Root should verify these deliberate source-derived grouping changes natively.

## Coworker / Box / chat inventory

Original Open order is **Chat, To handle, Apps, MCP, Skills, Database, Knowledge, Files, Routines, Triggers, Capabilities, Monitoring, Logs, Install, Settings**. All descriptors exist in current/40aa370 source; this does not prove every panel is installed/accepted. The checklist records accepted paths for Chat/Database/Knowledge/Files/Capabilities/Monitoring/Logs/Settings, Skills/Routines/MCP, To handle, Apps and Install. Triggers remains listed as a B5 native gap even though its tab is present in source. The new gate can disable that existing row with a visible reason instead of treating a broad panel callback as proof of readiness. To handle is omitted without a fresh pending item; Install uses its actual setup callback/capability rather than cloud template-author entitlement. Apps opening never connects a service or grants Apps; Capabilities opening never changes permissions.

Original coworker Actions: **Desktop** (missing from Mac Control Center construction; accepted isolated browser runtime exists but central viewer opener must be supplied), **Move to another Box** (already present; original move drill/order/source/destination validation preserved), **Notifications** (already present, exact coworker-pinned preferences). Disabled coworker Desktop refuses. Read-only panel navigation may remain available for a disabled coworker according to root capability; no background run starts.

Original Box page contains its current members, with select/drill into that coworker; move page contains other Boxes in original board order. No Rename/Delete command exists on the original Control Center Box page. Current Mac Box search/member drill/Move/New Box paths are retained; this package does not duplicate completed B2 mutations.

Original Control Center conversation rows open the exact saved session; no New chat/Delete/Rename/Archive/Mark-read command appears there. Accepted Mac adds actual Open chats (including persisted unsent tabs) and Recent conversations; existing shared reader excludes manufactured blank layout fallbacks. New projection retains exact tab UID plus nullable session, refuses cross-owner results and never manufactures a session or tab. It preserves actual source ordering and permits historical results only with their current exact identity. Pending Actions navigation opens the existing list; it never approves, answers or marks anything read.

Adjacent menus inspected, deliberately not widened into Control Center:

- Board coworker menu: Open chat, Rename, Settings, Share, Duplicate, Move to Box submenu, Delete; Box menu: Rename, Delete. Destructive/rename flows use original DeleteAgentDialog/DeleteSpaceDialog/RenameAgentDialog/RenameBoxDialog. They remain in those existing menus and canonical root mutation paths. Hosted Share is not activated by this package.
- Chat list: New chat, All/Chats/Automations/Needs you filters, history rows, individual mark-read and confirmed Mark all as read. Inspection does not create chats or mark read; explicit read receipts must continue through existing inbox authority and cannot answer approvals.
- Workspace menu: Settings/Invite header, Brain/proposals, AI providers, API keys & MCP, gated Servers/Billing, What's new, Weekly Rewind, hosted app accounts; existing workspace switching/New workspace; Templates author menu (My templates/New template), Expert sandbox, Admin, machine power, support/help, Account, Sign out. Only overlapping original Control Center entry points are included here. Multiworkspace/hosted/admin/billing/power/auth features are not invented locally. The local workspace menu's Team board/Shared database/Files/Templates/Brain/Control center/settings/coworker switches are unchanged and stay root-owned.

This is the complete source-derived Control Center inventory, with adjacent-menu boundaries explicit. B5 must not grow merely because a broader menu or checklist mentions a capability.

## Owned exports and implementation

New `@/lib/desktop/control-center-parity` exports:

- `ParityTarget`, `ParityIntent`, `ParityPage`, `ParitySnapshot`, `ParityCapability`, `ParityCommand`, `ParityActions`, `ParityNavigationBindings`, `ParityExecution`.
- `projectParitySnapshot` — real projection over canonical DesktopAgentView/board/persisted control-center chat/search data. Revisions derive from exact IDs and relevant current metadata. It ignores ambiguous recent status, refuses cross-owner rows and reuses H33 Foreman parser.
- `targetIsCurrent`, `intentIsCurrent` — exact workspace/owner/session/tab/Box/revision/current pending checks; no label lookup or selected-owner fallback.
- `createParityActions` — real dispatcher to supplied canonical callbacks with a fresh read immediately before invoking them. Missing callback produces unavailable, never success. It passes an execution signal/workspace/expected revision to every callback.
- `buildParityCommands`, `parityCommandSections`, `gateExistingParitySections`, `mergeParitySections`, `paritySemanticKey`, `HOSTED_CONTROL_COMMANDS`.
- `createParityController` — single-flight selection, immutable target snapshot before await, scope epoch/AbortSignal on close/query/drill/back, retryable errors and palette-local state only.

New UI adapters: `DesktopControlCenterParityView` reuses the actual original ControlCenterView and forwards all focus/dialog/crumb/query props. Busy/disabled rows lose both selection and drill callbacks, including keyboard shortcuts. `useControlCenterParity` links operation cancellation to root open/query/page/workspace selectionScope without registering shortcuts or taking ownership of board/chat state.

## Root binding and mounting fragments

Root owns central DesktopControlCenter/DesktopApp/Board/routes/dialogs/shortcut tables. None were edited. Keep ONE shortcut listener, ONE dialog/view and the board/chat mounted. Keep current camera/tab/draft persistence and onCloseAutoFocus/inert/quitting guards. No source here writes those states, reorders tabs, starts sessions, connects services, approves requests, changes tools or runs routines/triggers.

Create `ParityActions` with fresh canonical read and existing callbacks:

```ts
import {
  createParityActions, projectParitySnapshot, buildParityCommands,
  parityCommandSections, gateExistingParitySections, mergeParitySections,
} from '@/lib/desktop/control-center-parity'
import { useControlCenterParity } from '@/components/desktop/control-center-parity/useControlCenterParity'
import { DesktopControlCenterParityView } from '@/components/desktop/control-center-parity/DesktopControlCenterParityView'

const parityActions = createParityActions(
  readFreshControlCenterSnapshot,
  () => currentCanonicalBindings.current,
  currentControlCenterCapability,
)
const parity = useControlCenterParity(
  parityActions, open,
  JSON.stringify([workspaceId, workspaceRevision, selectionScope]),
)
// Convert existing root page's coworkerId to this adapter's agentId explicitly.
const page = toParityPage(existingPage)
const commands = buildParityCommands(snapshot, page, query, parityActions, {
  darkTheme, hasChangelog: false,
})
const offered = gateExistingParitySections(existingSections, snapshot, page, parityActions)
const additions = parityCommandSections(commands, command => {
  void parity.controller.execute(command).then(opened => {
    if (opened) setOpen(false)
  })
}, page)
const sections = mergeParitySections(offered, additions)
```

Render `DesktopControlCenterParityView` instead of ONLY the existing `<ControlCenterView>` call, forwarding existing open/onOpenChange/query/placeholder/pageKey/depth/crumbs/onBack/empty/mod/onCloseAutoFocus and passing `sections`, `busy={parity.state.busy}`, `notice={parity.state.notice}`. Root's existing stack/query/drill remains authoritative; do not additionally render a second palette or mount shortcut hooks again. Existing chat/search/attention loaders and recent-coworker persistence remain mounted exactly once. Existing retained rows keep their proven identity checks; new commands execute through the new controller/adapter. Original Back/Escape and focus return remain provided by the actual view and current root handlers.

`toParityPage` is a trivial explicit mapping: root → root, box.spaceId → box.spaceId, coworker.coworkerId → coworker.agentId, move.coworkerId → move.agentId. It must never read selectedCoworkerId as a substitute for a captured page ID.

`readFreshControlCenterSnapshot(signal)` is a concrete required root authority seam: refresh current owner/activity/board state and, where relevant, the existing persisted chat/search reader under its exact query/owner scope; wait for pending tab-write tails as `useDesktopControlCenterChats.refresh()` already does. Check the same selectionScope after each await and reject failures, then feed those actual results to `projectParitySnapshot`. Use canonical current saved-session identity for historical targets, not a cached title. Do not feed layoutOf's synthetic blank tab. The package implements projection/validation/dispatch, but it cannot read root's private currentRefs or refresh closures itself; absent this authoritative refresh port, root must leave the additions unavailable. No fictitious endpoint/default-success read is included.

`ParityNavigationBindings` canonical mapping:

| Binding | Existing root integration |
| --- | --- |
| global.new_agent | Existing onAddCoworker/add workflow |
| global.browse_templates | Real existing local templates-library opener (source available in workspace menu); root acceptance gated |
| global.new_box | Existing onAddBox / authoritative board command |
| global.recenter_board / toggle_theme | Existing explicit recenter / atomic saved-theme handler |
| global.workspace / ai_providers | Existing workspace-settings / model-settings dialogs |
| global.company_brain / shared_files | Existing local Brain / Shared files dialogs |
| global.notifications / shortcuts | Existing global preferences / shortcuts dialog |
| global.whats_new | Only a real root-owned local changelog handler; otherwise omit |
| panel(agentId,panel,execution) | Existing onOpenCoworkerPanel; Install uses actual setup editor handler; exact owner, no implicit selected fallback |
| notifications(agentId,execution) | Existing pinned coworker notification dialog |
| move(agentId,spaceId,execution) | Existing revision-checked board move path; recheck source/destination and existing mutation admission |
| openTab / openSaved | Existing onOpenChat / onOpenConversation; preserve original UID/session, draft, ordering and request guard |
| desktop(agentId,execution) | Missing central Control Center callback. Supply the accepted isolated viewer's exact-owner opener, with current guest/control/grant checks; not macOS desktop, native shell or a new screen owner. |
| assistant(chat,draft,execution) | Existing H33/I33 exact chat binding. Empty draft toggles/focuses that existing Foreman. Nonempty explicit Ask uses its real current conversation send authority, original behavior. Never send on search/drill/render, never dispatch from historical plan/build cards. |

Every callback receives `{signal,workspaceId,expectedRevision}`. Synchronous navigation must validate root's latest owner/workspace immediately before setting state. Any callback that awaits must honor signal/revision again at its actual commit; it cannot blindly apply a delayed selection to the current workspace. When handing focus to another dialog, use the existing central close/open sequencing; do not restore focus behind an open modal or overwrite an editor's draft. Failures must surface root's normal toast/palette retry notice, not silently create a replacement chat or pick a sibling. Existing destructive confirmations remain their existing paths; no destructive callback exists in this package.

`currentControlCenterCapability` must be per-action/per-panel, sourced from actual mounted/accepted dependencies. `ready` requires the real handler and current backend; `unavailable` retains a disabled row and explicit reason; `omit` follows original optional gates. Do not pass ready for every tab merely because onOpenCoworkerPanel exists. In particular Triggers/Foreman/templates/Desktop must reflect root review/activation, not source presence. Disabled coworkers may inspect metadata/settings; computer Desktop additionally refuses disabled state. To handle requires fresh pending state; it opens the existing list without approving/marking it read. Opening Apps/Tools/Install is navigation, not granting/installing/starting anything.

The I33 contract is not exported in this base. H33's exact chat identity adapter is reused without modifying it or its presentation. Root must export/mount I33 and bind the real Foreman chat before exposing Ask. No copied Foreman protocol, extra chat store, automatic send or hosted sign-up flow was added.

## State, restart and limits

There is no new durable navigation store. Palette-local query/page/busy/error state resets as original on opening; persisted board camera, selected chat, tabs/order/drafts, recent coworkers, exact open chats and settings continue to belong to existing root persistence. The snapshot projector reconstructs stable identities from restored data; it never creates a conversation by inspection. Closing/query/back/drill abort old execution reads. A deleted/replaced target, changed Box membership, bound formerly-unsent tab, pending request change or workspace generation mismatch refuses; identical titles/names never redirect. Failures clear busy and remain retryable. No automatic retry invokes a mutation or sends a message.

Original 250ms saved-title search debounce, two-character global conversation threshold, result caps and existing reader pagination stay in root's existing loaders; this package neither widens nor silently truncates them. Query controller bounds local input at 2,000 characters. Native narrow/short viewport, focus, reduced-motion behavior are inherited from original ControlCenterView/StepTransition, with no new animation/sizing scheme, and remain unverified until root QA.

## Supported / dependent / unsupported

| B5 slice | Source disposition | Native closure requirement |
| --- | --- | --- |
| Existing global/panel/chat/Box commands | Preserved and semantically deduplicated | Root regression/native checks after merge |
| Browse templates / Desktop / Ask assistant | New original-derived descriptors, controller and bindings | Actual accepted root handlers/authority required |
| Triggers and other source-only panels | Per-panel gating, disabled reason or original omission | Root backend/panel acceptance; no blanket-ready grant |
| Exact owner/session/workspace/Box targeting | Implemented projection, validation and callback adapter | Root authoritative fresh read/commit checks |
| Palette Back/Escape/keyboard/disabled/failure states | Original view reused plus owned execution lifecycle | Root mounted native QA, including reduced motion/focus |
| Draft/tab/camera/restart preservation | No new persistence writes; existing owners retained | Exact before/after Mac/restart comparisons |
| Hosted workspace/accounts/billing/support/admin | Intentionally omitted, no fake local equivalent | Outside local B5 scope unless separately assigned |
| Board/chat destructive menu additions | Not original CC; intentionally not added | Existing confirmations/authority unchanged |

Root could close the applicable **local Control Center contextual-navigation slice** only after wiring every required live handler and passing native/full-restart checks. This source commit cannot close B5 while Triggers/Foreman/Desktop/templates or authoritative read/mount dependencies remain unaccepted. Full hosted workspace/menu parity is not claimed.

## Changed files and authored regressions

- `apps/ui/lib/desktop/control-center-parity/types.ts`
- `apps/ui/lib/desktop/control-center-parity/authority.ts`
- `apps/ui/lib/desktop/control-center-parity/adapter.ts`
- `apps/ui/lib/desktop/control-center-parity/controller.ts`
- `apps/ui/lib/desktop/control-center-parity/commands.ts`
- `apps/ui/lib/desktop/control-center-parity/snapshot.ts`
- `apps/ui/lib/desktop/control-center-parity/index.ts`
- `apps/ui/lib/desktop/control-center-parity/parity.test.ts`
- `apps/ui/lib/desktop/control-center-parity/snapshot.test.ts`
- `apps/ui/components/desktop/control-center-parity/DesktopControlCenterParityView.tsx`
- `apps/ui/components/desktop/control-center-parity/useControlCenterParity.ts`
- `apps/ui/components/desktop/control-center-parity/DesktopControlCenterParityView.test.tsx`
- `docs/desktop-round34-h-handoff.md`

Regression sources cover original command/tab ordering, no invented destructive rows, hosted omission, templates/assistant placement, duplicate suppression, existing Trigger unavailability, exact owner/session/tab/workspace and disabled/deleted/Box/pending guards, retryable failures, late reads after close/query/drill/back, identical-title sibling isolation, stable restored snapshot identities and no synthesized chat, mounted board/draft retention on Escape, and busy drill/selection suppression. Authored only; UNRUN. Root additionally verifies real loader/mutation races, actual canonical routing/Foreman send boundaries, narrow/short/reduced-motion/focus and full restart.

No tests/typecheck/lint/build/install/server/UI/live API/provider/Docker/Keychain/installed-app/preview execution, external messaging, push, merge, publishing or deployment. All checks, fixes, integration and acceptance remain root's responsibility. No instruction to send a repair task back to the user.
