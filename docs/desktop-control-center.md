# Desktop control center (lane handoff)

Port of the original Rerun Control Center for the actions the Mac app already supports. Source-only lane: the integration owner runs all validation and Mac testing.

Base: `22a40524067ec8f36267a802e35ad5ca63dcad47`. Branch: `desktop/control-center-next`.

## What was ported

- `apps/ui/components/desktop/DesktopControlCenter.tsx` — the adapter component. It reuses the original view (`ControlCenterView`, unchanged) with `anchorToOrb={false}`, so the panel renders centered over whatever is on screen, with the original rows, keyboard selection, Tab/→ drill, Backspace return, skeletons, empty state and footer. No Supabase, session, hosted-store or billing dependency is imported.
- `apps/ui/lib/desktop/control-center.ts` — local helpers:
  - `buildDesktopControlCommands()` — the three commands the Mac supports, mirroring the original command shape (`add_coworker` → **Add coworker**, `team_board` → **Team board**, `model_settings` → **Model settings**). No fake billing, templates, Foreman, shared-files, members or account screens.
  - `useDesktopConversationSearch(text, enabled)` — the local title-search (`/api/desktop/conversations/search`) with the original debounce, aborting stale reads, and distinct loading / no-results / unavailable states. An answer only counts while it is still about the query on screen; the failed read surfaces as a **Try again** row that re-runs the search.
  - `pushRecentCoworker` — the original recent-list behavior (max 5, most recent first, each once).
  - `useDesktopControlCenterKeys({ open, setOpen, conversationOpen })` — the original ⌘F/⌘K capture listener, adapted.
- `apps/ui/components/desktop/DesktopControlCenter.test.tsx` — authored regression cases (not executed in this lane): shortcut behavior, scope prefixes, recent list, the three actions, search states, stale-read cancellation, retry, drill/scoping and exact-conversation selection.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/control-center/ControlCenter.tsx`
- `apps/ui/components/control-center/ControlCenterView.tsx` (reused verbatim)
- `apps/ui/components/control-center/types.ts` (reused verbatim)
- `apps/ui/components/control-center/useConversationSearch.ts`
- `apps/ui/lib/control-center/commands.ts` and `search.ts` (search primitives come from `@rerun/contracts`)
- `apps/ui/app/api/desktop/conversations/search/route.ts` and `lib/desktop/chat-search.ts` (the existing local API, unchanged)

## Minimal mounting and shortcut patch (root owns DesktopApp)

Mounting the component is the whole patch — the component binds its own capture listener, exactly like the original control center did:

```tsx
// apps/ui/components/desktop/DesktopApp.tsx
import { DesktopControlCenter } from './DesktopControlCenter'

// inside DesktopApp's returned <main>, after the board/panel block:
<DesktopControlCenter
    coworkers={agents}
    selectedCoworkerId={panelOpen ? selectedAgentId : null}
    onOpenConversation={hit => selectCoworker(hit.agentId, hit.id)}
    onAddCoworker={() => showBoard(true)}
    onModelSettings={() => setSettings(true)}
    onBackToBoard={() => showBoard()}
/>
```

`selectedCoworkerId` follows the same convention as `DesktopBoard`'s `selectedAgentId`: null while the board shows, the open coworker otherwise. `onOpenConversation` must be the same handler `DesktopBoard` already uses for `DesktopFindChat`, so opening a result selects that exact session and keeps the existing chat drafts (per-tab writes and the quit flush) and the board layout/camera untouched — the center itself holds no draft and never touches the board.

`onModelSettings` maps to the existing settings overlay (the workspace menu's "Open model settings" button); `onAddCoworker` maps to `showBoard(true)` (the board with the create-coworker dialog); `onBackToBoard` maps to `showBoard()`. All three are real supplied callbacks; the center renders no other actions.

## Shortcut behavior

- **⌘F on a Mac, Ctrl+F elsewhere** (the original rule): opens the centered panel. Pressed while open it only closes it and claims nothing else. Shift/Alt never trigger it, and on a Mac Ctrl+F is left to the caret.
- **⌘K** toggles the center where nothing else holds it, following the original's "without an assistant it toggles as ⌘F does" rule, with the lane's two guards: it is never taken from an open coworker chat (`conversationOpen`) — `DesktopChatTabs` binds ⌘K to start a new conversation there — and never from an editing field (`input`, `textarea`, contenteditable). With the center open, ⌘K still just closes it.
- The listener sits on `window` in the capture phase, before every local handler, and ignores keyless autofill events like the original.

## Structure

- Pages: root and per-coworker only. The original's Box and move pages have no Mac equivalent and were dropped; ⌘K/⌘F scope prefixes (`@`, `/`) and the root's Recent/others cap (8), Actions and Settings sections follow the original layout.
- Coworker rows show the name, the description as detail and an **Off** badge for `enabled === false`, and drill into a per-coworker page (Enter or Tab) whose only content is that coworker's saved chats — opening a coworker's chat remains the board tile's action, so the center claims no callback for it. Per-coworker results filter the workspace-wide search by `hit.agentId` on the client.
- Conversation rows carry the exact `DesktopConversationHit` (local coworker and session IDs) to `onOpenConversation`; on the root they show the coworker's name as detail. The 50-hit refinement hint from `DesktopFindChat` is not reproduced (the shared view has no footnote slot; the API still caps at 50).

## Unverified limitations

- The lane ran nothing: tests, type checks and builds are the integration owner's. The authored cases live in `DesktopControlCenter.test.tsx`.
- The reused view's footer hints "⌘F again to search in the page", which describes the web browser; in the Mac shell pressing ⌘F again just closes the center. The copy is inherited unchanged from the original view to keep the reuse verbatim; root may want a desktop variant of that hint later.
- The centered layout never anchors to an orb (the Mac has no Foreman orb), so `anchorToOrb` stays false.
- The ⌘K editing-field guard is a deliberate desktop addition on top of the original rules; on the web the original opens the center from any field.
- `hasMore` from the search hook is carried but unused in the UI, as above.
- The component assumes it is mounted once per app root; the recent list lives in its own state and resets on unmount.
