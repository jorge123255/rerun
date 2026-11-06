# Round 35 G — Original draggable Foreman dock and parked activity

Source-only handoff. Branch `desktop/round35-foreman-dock`, prepared base `5c0f589b51a8129d097f2b97fc420a8acf859b51`. The initial HEAD/branch matched and `git status --short` was empty. No execution checks, tests, typechecks, lint, builds, installs, servers, providers, microphone, browser/native UI, credentials, Keychain, Docker or restart QA were run. No acceptance or checklist closure is claimed. Root integrates, executes and repairs findings.

## Original mapping and source inventory

All original references below were inspected through Git object `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`; current local callers were read separately.

| Original source | Retained behavior / Mac adaptation |
| --- | --- |
| `apps/ui/components/foreman/useForemanDrag.ts` | Header drag excludes controls; 6px lift, 24px grab margin, edge dock/center quadrant selection, cancel-before-close Escape capture, cursor cleanup. Local callbacks replace original global store. Landing uses reduced-motion-aware 0.22s motion layout instead of the original imperative DOM animation. |
| `apps/ui/lib/foreman-layout.ts` | Reuses its types, edge snap (80px), float/dock clamp and corner resolver directly. Defaults/reset dimensions remain original 480×720 / 480 dock. Existing saved Mac sizes are retained. New clamp handles screens smaller than original 360×420 minima without offscreen controls. |
| `apps/ui/components/foreman/ForemanColumn.tsx` | One mounted column, dock left/right or floating corner; existing chat/routines/header/composer remain root content. No new conversation implementation. |
| `apps/ui/components/foreman/ForemanResizeHandle.tsx`, `ForemanDockResizeHandle.tsx` | Opposite float-corner resize, inner dock edge, Resize chat label, double-click reset. Pointer cancellation now rolls back rather than committing partial dimensions. Focusable separator adds local keyboard resizing/placement. |
| `apps/ui/components/foreman/useForemanSheetResize.ts`, `apps/ui/components/layout/useSheetResize.ts` | Medium/large sheet, 6px lift, 0.4px/ms and quarter-height dismissal thresholds, 100ms velocity samples, original 0.998 projected velocity. Reuses elastic large-detent overshoot and translation below the medium floor, with safe-area max-height. The original imperative 500ms dismissal handoff is replaced by reduced-motion-aware frame motion. No new global keyboard shortcut. |
| `apps/ui/components/foreman/ForemanDropPreview.tsx` | Original primary/40 border, primary/5 fill, 14px radius, 0.18s reduced-motion-aware preview; callback state replaces global store. |
| `apps/ui/components/foreman/ForemanDock.tsx` | Actual parked Orb sizes, original chrome/board offsets, independent orb corner, nearest-corner dragging, 0.22s appearance, drag/click distinction and wide-only pill. Local callbacks replace session/store/hosted control-center access. |
| `apps/ui/components/foreman/dock/ForemanDockBubble.tsx`, `ForemanNudge.tsx`, `ForemanReplyBubble.tsx`, `ForemanPill.tsx`, `ForemanPillTicker.tsx` | Imports actual components directly: same bubbles/tails, Review/Answer/Later, Dismiss, Open the conversation, ticker and generic loading labels. No rewritten visual substitute. |
| `apps/ui/lib/foreman/dock-feed.ts`, `apps/ui/components/foreman/useForemanDockFeed.ts` | Exact-chat projection, only witnessed closed-run reply announcement, pending nudge is navigation only; reading the column clears reply announcement. No history-triggered open/send/answer. |

Current authority: `foreman-client/{persistence,actions,runtime-client,ui-schema}.ts`, `useDesktopForemanUi.ts`, `DesktopForeman{Panel,Column,Header,Dock}.tsx`, `DesktopApp.tsx`, local server `foreman/{binding,chat-store}.ts` and canonical `packages/contracts/src/desktop-foreman.ts`. The existing CAS writer recovers lost ACK only when the server snapshot equals the exact attempted snapshot. This package deliberately does not implement another revision writer.

Read `CLAUDE.md`, `apps/ui/{AGENTS,CLAUDE}.md`, assignment standard and E11/board checklist. Required installed Next.js guide was absent at both `node_modules/next/dist/docs` and `apps/ui/node_modules/next/dist/docs`; no dependencies were installed. This package uses React/motion APIs and no Next APIs.

## Changed files

All paths are new and owned:

- `apps/ui/lib/desktop/foreman-dock/layout.ts`: responsive geometry, independent preferences and sheet settling.
- `.../persistence.ts`: 180ms coalescing, exact owner admission, concrete binding to current hook setters and canonical save drain, quit-drain registration.
- `.../feed.ts`: exact feed contract, parked observer/dismissals and concrete current-client-state projection.
- `.../schema.ts`: additive saved preference schema.
- `.../index.ts`: local exports.
- `.../layout.test.ts`, `persistence.test.ts`, `feed.test.ts`: authored regressions.
- `apps/ui/components/desktop/foreman/dock/useDockGeometry.ts`: owned pointer lifecycle and interruption cleanup.
- `.../useDesktopForemanDockBinding.ts`: optimistic geometry/preferences with debounced existing UI persistence.
- `.../DesktopForemanDockLayout.tsx`: replacement outer frame/preview/resizers around original content.
- `.../DesktopParkedForeman.tsx`: actual original Orb/bubble/pill components and injected composer/voice slots.
- `.../index.ts`: local exports.
- `.../dock.test.tsx`, `parked.test.tsx`: mounted regression sources.
- `docs/desktop-round35-g-handoff.md`: this handoff.

## Public contracts and concrete bindings

```ts
// Existing ForemanPlacement / DesktopForemanChatRef types, not copies.
type DockExtras = {
  orbCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  sheetDetent: 'medium' | 'large' | null
}
type DockChange = { placement?: DesktopForemanPlacement; dock?: DockExtras }
createDockPersistence(binding: DockSaveBinding, delay = 180): {
  activate(): void
  change(change: DockChange): void
  flush(): Promise<boolean>
  dispose(): void
}
bindForemanPlacement({ chat, current, setPlacement, setDock }): DockSaveBinding
flushForemanDockPlacements(): Promise<boolean>
```

`bindForemanPlacement` invokes the actual current hook setters; it does not post snapshots or cache credentials, drafts, revisions or messages. `flush()` admits its pending patch and awaits existing `flushDesktopForemanUiSaves()`. `activate` supports React effect replay; old workspace timers are discarded on identity mismatch, disposed writers refuse changes. Root must leave the same owner alive while parked and flush before destroying its hook. A timer admitted to an old owner is fenced by the existing server CAS; it cannot silently adopt a newer revision.

```ts
type ExactDockFeed = DesktopForemanChatRef & {
  source: 'current' | 'history'; runId: string | null
  busy: boolean; label: string | null
  pending: (ForemanNudge & { runId: string; requestId: string }) | null
  reply: { id: string; text: string; runId: string } | null
  failed: { runId: string } | null
}
createClientDockFeed(chat)(state: DesktopForemanClientState): ExactDockFeed | null
createParkedFeed(chat): { accept(feed, open); dismiss(id) }
```

The concrete client projector uses the canonical same-chat messages/current `view.live`. It observes a busy→idle transition and a changed assistant message signature (streamed same-ID text is supported), never labels an initial historical reply as new. It latches one completed reply until another observed run. Root feeds state through this projector in canonical publication order, not parallel stale HTTP callbacks. Missed between-poll turns are not inferred. The existing DTO has **no authoritative tool-label, pending HITL request or final failure result**, so projection leaves label/pending/failed null and uses the original generic busy ticker. Root can supply the typed exact feed when those fields exist. Do not infer requests/errors from prose, plan decisions or tool names in old transcript. Pending and failures cannot be fabricated to satisfy the visual slot.

`DesktopForemanDockLayout` takes controlled placement/preferences/open/hidden/scope, mutation callbacks, a focus-return target and `children(headerBindings)`. Pass `headerBindings.onPointerDown` to the existing `DesktopForemanHeader.onDragPointerDown`. It owns only gesture Escape while an active gesture exists; retain the current `useDesktopForemanUi` Escape close listener once. Keyboard on the resize separator: arrows resize, Home resets, Alt+Left/Right dock, Alt+Up/Down float in the corresponding corner. Mobile uses the grabber button (tap toggles detent; drag resizes/dismisses).

`DesktopParkedForeman` takes exact chat/feed, controlled corner/open/visibility/media-query state, explicit onOpen/onCorner/onTrigger, and optional **ReactNode** `voiceSlot` / `composerSlot`. It never imports capture, transcription or message sending. Root supplies F's view only when its view is active (undefined otherwise, so the busy ticker remains). Existing accepted composer submission/model/Stop remains root-owned. No automatic compose/send behavior is implemented here.

F dependency inspected read-only: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round35-foreman-voice`, HEAD `5c0f589b51a8129d097f2b97fc420a8acf859b51`, uncommitted `packages/contracts/src/desktop-foreman-voice.ts` blob `86d8b21018341b9335b692435c888bc24d8b239b`. It exports `ForemanVoiceTarget={chat,model}`, `ForemanVoiceSnapshot`, `ForemanVoiceAccepted`, request schemas and `sameForemanVoiceTarget`. No committed renderer/voice-slot contract was available when inspected. This package intentionally does not duplicate F's protocol, invent a component name or depend on that changing uncommitted file. The existing `composerTrailing?: ReactNode` and this package's `voiceSlot?: ReactNode` are the concrete compatible UI seam. Root verifies F's final commit before mounting it; no capture/transcription capability is claimed by G.

## Exact root patches — not applied

### 1. Add optional settings to the SAME UI snapshot

In `apps/ui/lib/desktop/foreman-client/persistence.ts`, import owned `DockExtras` and add to `DesktopForemanPersistedUi`:

```ts
import type { DockExtras } from '@/lib/desktop/foreman-dock/layout'
// Inside DesktopForemanPersistedUi:
dock?: DockExtras
```

In `ui-schema.ts`, add the optional field to its existing strict object (including the existing server consumer of that schema):

```ts
import { desktopForemanDockExtrasSchema } from '@/lib/desktop/foreman-dock/schema'
// Inside desktopForemanSavedUiSchema:
dock: desktopForemanDockExtrasSchema.optional(),
```

No new database/table, cookie or localStorage key. Existing old rows lacking this field restore using `DEFAULT_DOCK_EXTRAS`. No numbered SQLite migration is required because current `desktop_foreman_chats.ui` is a revisioned JSON snapshot; root must preserve optional compatibility on BOTH read and write validators. If root changes persisted envelope semantics instead, root owns its additive migration. Never strip this field on the runtime read-back path or saved-ACK equality recovery.

In `useDesktopForemanUi.ts`, expand its `earlyUi` Pick to include `'dock'`; add the following beside `setPlacement`, and return `setDock` with other setters:

```ts
const setDock = useCallback((dock: DockExtras) => {
    if (!valid()) return
    owner.earlyUi.dock = dock
    commit(state => ({ ...state, ui: { ...state.ui, dock } }))
}, [owner, commit, valid])
```

Imports: owned `DockExtras`; `setPlacement` already commits through this same owner and CAS queue. No separate async full-snapshot patch writer is permitted. The preference spread in `persisted(state)` already carries optional fields.

### 2. Replace the column OUTER FRAME only

In root's current `DesktopForemanColumn.tsx`, keep its **single** `useDesktopForemanUi` call, all chat/routines/plan/discovery/composer logic and existing header contents. Import:

```tsx
import { DesktopForemanDockLayout, DesktopParkedForeman,
  useDesktopForemanDockBinding } from './dock'
import { DEFAULT_DOCK_EXTRAS } from '@/lib/desktop/foreman-dock'
```

Immediately after its current `ui` binding:

```tsx
const triggerRef = useRef<HTMLElement | null>(null)
const dockBinding = useDesktopForemanDockBinding({
  chat, placement: ui.placement, dock: ui.dock ?? DEFAULT_DOCK_EXTRAS,
  setPlacement: foreman.setPlacement, setDock: foreman.setDock,
})
```

Replace the current outer positioning/frame divs (not the existing content) with:

```tsx
<DesktopForemanDockLayout
  scope={dockBinding.scope} open={ui.open} hidden={hidden}
  placement={dockBinding.placement} dock={dockBinding.dock}
  onPlacement={dockBinding.onPlacement} onDock={dockBinding.onDock}
  onClose={() => foreman.setOpen(false)} returnFocus={() => triggerRef.current}
>
  {header => <>
    <DesktopForemanHeader
      /* preserve its existing anchor/orb/open/tab/onTabChange/onClose/actions props */
      onDragPointerDown={header.onPointerDown}
    />
    {/* Existing ChatLayer/Composer/Routines content verbatim; no nested old outer frame. */}
  </>}
</DesktopForemanDockLayout>
<DesktopParkedForeman
  chat={chat} open={ui.open} hidden={hidden} centerOpen={centerOpen}
  mobile={mobile} wide={wide}
  corner={!mobile && dockBinding.placement.mode === 'float'
    ? dockBinding.placement.corner : dockBinding.dock.orbCorner}
  onCorner={corner => {
    dockBinding.onDock({ ...dockBinding.dock, orbCorner: corner })
    if (!mobile && dockBinding.placement.mode === 'float')
      dockBinding.onPlacement({ ...dockBinding.placement, corner })
  }}
  onOpen={() => { if (!isDesktopQuitting()) foreman.setOpen(true) }}
  feed={dockFeed} voiceSlot={activeVoiceSlot} composerSlot={acceptedParkedComposer}
  onTrigger={node => { triggerRef.current = node }}
/>
```

The JSX comments above identify existing content/props to retain; they are not placeholder implementations. New optional column/Panel inputs root threads: `hidden`, `centerOpen`, `mobile`, `wide`, `dockFeed`, voice/composer slots. `hidden` includes quitting, minimized/hidden app, competing coworker panel and global covering modal. Resolve mobile `<768px` and wide `>=1024px` through root's current media query hook, no new polling or keyboard listener. Keep current composer visible/authoritative in the column. Root focuses its canonical composer after an explicit open; this frame returns focus on close and does not compete with root focus-on-open logic. Flush pending dock placement before deliberate panel teardown/workspace navigation, or keep owner alive.

### 3. Keep the client alive while parked; current App conditional cannot provide activity

Current `DesktopApp.tsx:469–473` mounts a static orb and conditionally mounts `DesktopForemanPanel` only while `foremanOpen`; remove that static orb, and do not unmount the connected Foreman owner when the column closes. Add a `foremanEngaged` latch set only by an explicit Open Foreman action (including original orb/Control Center action); loading the board must not create a Foreman chat. Until engaged, retain the existing static orb as the bootstrap trigger; remove it atomically once the connected owner takes over. **Never mount both parked overlays together.**

After engagement, render the existing panel under a keyed exact-chat owner for the workspace lifetime, with its controlled open request. In `DesktopForemanPanel` / `ConnectedForeman`, replace `openOnMount` with an explicit monotonic open request prop (increment only on human open), handled once by `foreman.setOpen(true)` when restored. Close changes the existing UI `open` false and notifies root, but leaves that same client/hook mounted. Do not call `setOpen(true)` on poll, restore or feed change. Workspace navigation/quit must await owned flush before unmount. The current persisted open flag remains owned by that hook; root mirrors it to grid/inset without writing camera/chat selection.

Connect the actual existing `ConnectedForeman` state with one projector per exact chat:

```tsx
const dockFeedOf = useMemo(() => createClientDockFeed(initial.chat),
  [initial.chat.workspaceId, initial.chat.chatId])
// Project in the existing accepted onState publication, then pass its result to Column.
// Also initialize its history feed from `initial`; it causes no write or open.
const [dockFeed, setDockFeed] = useState(() => dockFeedOf(initial))
// Inside existing guarded onState(next), alongside setState(next):
setDockFeed(dockFeedOf(next))
```

Do not add a second EventSource, polling loop or runtime client. Continue the existing current-state refresh while parked. Scope-key all parked observers so no old feed/dismissal leaks to another chat. When root adds authoritative request/failure DTOs, map them to `ExactDockFeed` using real request/run IDs and retain the same gate. The above fragment supports current busy/latest-reply data now; pending/failure parity remains dependent.

### 4. Grid and board offsets

The existing hardcoded `420px` tracks and `panelInsetRight={...420}` must consume the actual clamped placement while open. For a dock, set only its occupied track to `dockWidth` (opposite track 0); for a float or closed column both tracks are 0. Keep the board mounted in its same DOM position. Render the floating frame/parked orb outside a transformed board-camera subtree. Frame has its own `position:fixed` and `z-50`, orb uses original `z-40`. Existing plan/discoveries overlays stay in their root-owned host, not inside a second frame.

```tsx
// With the layout's current open/drag state mirrored read-only to the existing split:
const leftTrack = open && placement.mode === 'dock' && placement.side === 'left' ? placement.dockWidth : 0
const rightTrack = open && placement.mode === 'dock' && placement.side === 'right' ? placement.dockWidth : 0
// Desktop gridTemplateColumns: `${leftTrack}px minmax(0,1fr) ${rightTrack}px`
// Existing board panelInsetRight: rightTrack (or coworker inset when that panel owns it).
```

Root must publish placement/open as presentation state, not pan/recenter the camera or change selected chat. `DesktopForemanDockLayout.onLayout` publishes `{scope,open,placement,dragging,mobile}` from layout effect with already-bounded current geometry. Root passes a stable callback scoped to the exact chat and stores this presentation projection in the existing split. Use `open && !dragging && !mobile` in the track expressions above. The frame already follows the pointer; this callback supplies original grid-collapse behavior without another screen/layout authority. Ignore callback deliveries whose scope is no longer the mounted chat. On close its open is false; on hidden/minimized it also publishes false. Do not run Board resize code that mutates camera state in response to this layout.

### 5. Quit ordering and failures

Import `flushForemanDockPlacements` from the owned library into current DesktopApp. Its existing `onBeforeQuit` handler must await:

```ts
const dockReady = await flushForemanDockPlacements()
// Then the existing Promise.all: flushDesktopDrafts, flushDesktopBrainDrafts,
// flushDesktopForemanUiSaves, flushDesktopRecentCoworkers.
const ready = dockReady && chatReady && brainReady && foremanReady
```

Do not put dock flush and canonical Foreman flush in parallel: the former first admits the debounced write. Preserve existing refusal/cancelled-quit behavior and surface hook save errors. Do not unregister/unmount the owner before this handshake. No beforeunload fire-and-forget substitute. On a lost ACK, existing exact-snapshot readback recovers; a different newer revision remains a conflict and quit is refused. Root may reuse its existing deliberate UI retry/reopen, never overwrite newer placement automatically.

## Persistence, recovery and scope

- Preferred float/dock geometry and the additive orb/detent settings ride the same versioned UI JSON. No cookies or localStorage; no chat/model/plan authority copied.
- Only completed deliberate gestures/keyboard commands change settings; viewport resize merely projects the preferred geometry into visible bounds and does not save smaller dimensions over the preference.
- Debounced same-owner changes coalesce; explicit quit flush is required. Abrupt process kill inside 180ms can lose the unsaved last gesture; after admission existing durable CAS semantics apply. This is not a durable local outbox and does not claim one.
- Wrong-owner delayed mutations are discarded before admission. Once admitted, existing exact CAS/lost-ACK checks apply; failure remains visible/blocks quit. A previously discarded timer is not replayed after returning to that workspace.
- Restart restores saved preferences and bounded controls; no launch, send, answer or run occurs. Historical reply announcements are not restored. Dismiss/Later are bounded in-memory view state per exact chat, matching original transient dismissal; they do not mark requests answered or persist an answer.
- Scope/open/hidden/blur/visibility/resize interruptions roll back gestures; Escape is consumed only for an active gesture. Other Escape behavior stays in the existing root hook.

## Supported / dependent / unsupported

| Area | Owned source supports | Root/dependency or limit |
| --- | --- | --- |
| Dock/float/resize/sheet | Real pointer geometry, six-pixel click distinction, bounded previews, corner snap, cancellation, resize keyboard | Root replaces outer frame and grid/inset constants; exact original imperative 500ms sheet dismissal handoff replaced by frame motion |
| Persistence | Concrete current-hook binding, debounce, scoped settings, canonical flush | Root adds optional extras field/setter and quit order; abrupt pre-debounce process kill loses that last gesture |
| Parked UI | Original Orb, bubbles/nudge/ticker, manual dismiss, exact chat/run gate | Root keeps actual client alive parked and wires exact current feed |
| Activity/reply | Current canonical live + changed assistant reply, restored-history suppression | Generic activity label only; missed between-poll turns not inferred; no fabricated completion |
| Pending/failure nudge | Typed exact current-run/request presentation and no answer effects | Canonical DTO lacks pending/final-failure fields; root must supply actual fields before enabling these branches |
| Voice/composition | Explicit ReactNode slots only | F final renderer and root accepted send/model/Stop binding; no microphone/transcription implemented by G |
| Board/focus | Mounted content, close return target, no camera/selection operations | Root preserves board DOM/camera and canonical focus-on-open/hidden/minimized state |
| Hosted and automated effects | None | No hosted session/provider calls, no auto-send, no auto-open, no permission change |

## Authored-but-unrun regressions

- Geometry: original snap targets, dock maximum, tiny/minimized windows, restored huge geometry without preference writes, mobile detent/dismiss thresholds.
- Persistence: coalescing, immutable final patch, exact owner switches, canonical failed/lost-ACK drain not reported successful, setter binding without draft replacement.
- Feed: restored/historical replies, cross-chat/run refusal, witnessed closed-run reply, manual dismiss, column reading/reopen, exact pending request, no answer/open side effects.
- Mounted frame: Escape interruption, below-threshold click, stale-owner resize release, changed viewport clamp, focus return, mounted draft preservation, local keyboard placement.
- Mounted parked component: initial historical answer hidden, busy→reply, Dismiss and reopen do not replay, feed updates never call open, explicit trigger does once.

These are source cases, not passing results. Pointer/motion timing, animation/short-width rendering, F slot integration, server CAS recovery, canonical feed additions and full restart remain root execution/native acceptance work. Shared E11/board checklist remains unchecked by this handoff.
