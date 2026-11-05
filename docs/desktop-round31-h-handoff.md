# Round 31 — Lane H handoff: E3 live browser preview in ordinary chat runs

Status: **source only, unverified.** No tests, typecheck, lint, build, server, UI or app action was
run. Not accepted; E3 is not marked complete. Root runs every check and the real Codex / board /
full-restart acceptance.

Base `136f318e931a4433ea6d178f3f9e961e1a2d8a86`; branch `desktop/round31-browser-live-preview`.
No prior lane work existed in this worktree. `node_modules/next/dist/docs` is not installed in this
worktree, so no Next.js guide could be read; nothing here uses Next-specific APIs (client components only).

## Changed files (all owned)

- `apps/ui/lib/desktop/browser-run.ts` — identity, strict parse, projection, observer, transport adapter
- `apps/ui/lib/desktop/browser-run.test.ts` — regression source (unrun)
- `apps/ui/components/desktop/browser-runs/BrowserRunScreen.tsx` — ChatScreen adaptation
- `apps/ui/components/desktop/browser-runs/useBrowserRunScreen.ts` — observer hook, page visibility
- `apps/ui/components/desktop/browser-runs/index.ts` — exports
- `apps/ui/components/desktop/browser-runs/BrowserRunScreen.test.tsx` — regression source (unrun)
- `docs/desktop-round31-h-handoff.md`

## Original source mapping (`a6d63a4b542674ddd002e51b39ba0df6e0807bcc`)

| Original | Local |
| --- | --- |
| `apps/ui/components/chat/ChatScreen.tsx` `ChatScreen` (active && selected gate → fallback) | `BrowserRunScreen` + `projectBrowserRunScreen` (adds trusted exact run, visibility, takeover gate) |
| `ChatScreen.tsx` `ScreenBlock` (card ref/arriveRef, unavailable → fallback, floating portal `!cardSeen && !driving`) | `BrowserRunBlock` (same structure; `fullViewerOpen` replaces `driving`; unavailable shows card + Retry instead of silent fallback, as E3 requires) |
| `apps/ui/components/desktop/ScreenCard.tsx` | reused unchanged (aspect-video, rounded-xl ring, site badge, `TakeControlOverlay` "Take control") |
| `apps/ui/components/desktop/ScreenFace.tsx` | reused for loading/live; `BrowserRunFace` keeps its exact classes/icon/labels ("The screen is not available", "The screen went away") and adds a Try again button |
| `apps/ui/components/desktop/DesktopViewer.tsx` | reused unchanged with `viewOnly` (RFB viewOnly, pointer-events-none, `onCanvas`) |
| `apps/ui/components/desktop/FloatingScreen.tsx` | reused unchanged (drag along edge, side/width memory, Take control unless dragged), `className="top-1"` |
| `apps/ui/components/desktop/ScreenMirror.tsx` | reused unchanged: mirrors the inline canvas, no second socket |
| `apps/ui/hooks/useAgentScreen.ts` (`openDesktopAction(agentId,'watch')` on mount, ticket lives a minute, remount to watch again) | `createBrowserRunObserver` / `useBrowserRunScreen`: injected check → watch ticket → recheck; keyed remount per run |
| `apps/ui/hooks/useSeenInThread.ts` | reused unchanged (IntersectionObserver on the supplied scroller, no layout changes) |

The local `FloatingScreen`, `ScreenMirror`, `ScreenCard`, `ScreenFace`, `DesktopViewer`, `useSeenInThread`
already exist at base (FloatingScreen/ScreenMirror byte-identical to the original); none were edited.

## Exported API

From `@/lib/desktop/browser-run`:
- types `BrowserRunIdentity {agentId,sessionId,runId}`, `TrustedLiveScreen {kind:'browser'|'computer'; site}`,
  `TrustedCurrentRun`, `CurrentRunCheck`, `CurrentRunCheckResult`, `PassiveViewerTransport`,
  `PassiveViewerTicket`, `BrowserRunScreenState` (`idle|loading|live|disconnected|unavailable|stopped`),
  `BrowserRunConversation`, `BrowserRunEligibility`, `BrowserRunObserver`
- `parseTrustedCurrentRun(unknown)` — strict exact-key parse, ID charset, fails closed
- `projectBrowserRunScreen({trusted, conversation, takeoverPending})`
- `projectSavedRun(savedRunId, trusted, conversation)` → `'current'|'historical'`
- `sanitizeSite`, `isAcceptableSocketUrl`, `sameRun`, `runKey`, `BROWSER_RUN_LIMITS`
  (`setupMs 15000, connectMs 20000, checkMs 10000, siteChars 80`)
- `createBrowserRunObserver({run, check, transport, onState, limits?, now?})` → `{start, retry, connected, disconnected, dispose, state, generation}`
- `createScreenClientPassiveTransport(requestDesktopScreenTicket)` (see H-D1 before wiring)

From `@/components/desktop/browser-runs`: `BrowserRunScreen`, `BrowserRunScreenProps`,
`SCREEN_CONTROL_LABEL`, `useBrowserRunScreen`, `usePageVisible`.

## Root wiring (DesktopConversation — root-owned, not edited)

```tsx
import { BrowserRunScreen } from '@/components/desktop/browser-runs'
import { createScreenClientPassiveTransport, parseTrustedCurrentRun } from '@/lib/desktop/browser-run'
import { requestDesktopScreenTicket } from '@/lib/desktop/screen-client'

// Module scope: stable identity.
const passiveTransport = createScreenClientPassiveTransport((agentId, mode, signal) => requestDesktopScreenTicket(agentId, mode, signal))

// trustedRun: root's current-run projection for this exact session (from its run event/status
// stream), e.g. extended /api/desktop/sessions/[id] status { runId, liveScreen } — never derived
// from transcript text or tool names.
const trustedRun = parseTrustedCurrentRun(currentRunProjection)

// In the active run's last block, where the activity loader is rendered today:
<BrowserRunScreen
    trusted={trustedRun}
    agentId={agent.id}
    sessionId={sessionId}
    active={active}
    selected={boardSelectedAgentId === agent.id}
    takeoverPending={!!takeover}            // DesktopBrowserCard already shows this screen
    fullViewerOpen={screenOpen !== null}
    checkCurrentRun={checkBrowserRun}       // H-D2
    transport={passiveTransport}
    onOpenFullViewer={async run => {        // acknowledged; exact identity
        if (run.agentId !== agent.id || run.sessionId !== sessionId || run.runId !== activeRunId) throw new Error('stale')
        setScreenOpen('manual')              // 'manual', never 'request': not a takeover answer
    }}
    scroller={threadScrollerEl}
    floatingHost={chatBoxEl}                 // relative container; FloatingScreen is absolute
    arriveRef={arriveRef}
    fallback={activityLoader}
/>
```

`setScreenOpen('manual')` keeps board position, chat scroll and draft because it only toggles the
existing `IsolatedScreenDialog`; the card stays mounted underneath (only the floating mirror is
suppressed). Opening never calls the takeover `onAction`, so it cannot Done/Skip a pending request.

## Dependencies (root / shared; not duplicated here)

- **H-D1 (shared, essential).** The existing watch path can start a guest: `POST …/screen {action:'view',mode:'watch'}`
  → engine `isolated-viewer.ts` `/view` → `ensure()`, and `/status` maps a stopped or absent container to
  `'available'` (`isolated-screen/binding.ts`). Passive viewing therefore needs either a watch
  ticket that refuses a non-running guest (e.g. `{action:'view', mode:'watch', requireRunning:true}` →
  service checks `container.state === 'running'` without `ensure`) or a status field that exposes
  `running`. Lane G / root owns those files. Until then the only guard is H-D2 reporting `'running'`
  just before the ticket, which leaves a small stop-vs-ticket race that could restart a guest.
- **H-D2 (root).** `checkBrowserRun(run, signal)`: server route reading current trusted state — exact
  local coworker, session, active runId, enabled/not deleting, browser/computer grant, and guest
  actually running (engine run state, not `'available'`). Return `{current:false}` for any mismatch.
- **H-D3 (root).** The trusted current-run projection `{agentId,sessionId,runId,liveScreen}` emitted by
  root's run events when a browser/computer tool is actually executing for that run, cleared on
  Stop/completion/failure. `liveScreen.site` = current page host (sanitised again here).
- **H-D4 (root).** Mounting, board selection, `floatingHost`/`scroller` elements and `screenOpen` state.

## Lifecycle, persistence, restart, cancel, errors

- Observer per exact run (React key = `runKey`). Owner/session/run change, Stop/completion (trusted→null or
  check `{current:false}`), inactive tab, unselected coworker, hidden window (`visibilitychange`) or unmount
  disposes it: abort in-flight check/ticket, bump generation (late replies dropped), unmount only its
  own `DesktopViewer` (RFB disconnect of this watch socket). It has no stop/release/takeover method, so
  it cannot stop the guest, release a lease or close another viewer.
- Sequence per attempt: check → (running) watch ticket → check again → live. Stale/stopped → fallback;
  unavailable/errors → fixed text + Try again. Errors never carry URLs or tickets.
- Bounds: setup 15 s overall, each check 10 s, live socket must paint within 20 s or becomes
  "The screen did not connect" (no frozen live card). No automatic reconnect; Retry starts a fresh
  validated attempt; obsolete attempts cannot overwrite a newer one.
- Persistence: none. Tickets/socket URLs live only in component state; nothing touches drafts,
  history, storage or logs. FloatingScreen's original side/width preference in localStorage is the only
  stored value. After a full restart a mount revalidates from scratch; no replayed actions, no ticket
  or control resurrection; saved runs project as historical (`projectSavedRun`).

## Feature matrix

| # | Requirement | State |
| --- | --- | --- |
| 1 | Trusted exact-identity adapter, validate before view | Implemented; projection source is H-D3, check is H-D2 |
| 2 | Original inline card/face/badge/Open/fallback, responsive | Implemented by reusing originals (`max-w-[95%]`, aspect-video) |
| 3 | Passive viewOnly, no start/control/input | Implemented client-side (watch only, no lease); server no-start guarantee **depends on H-D1** |
| 4 | Tab/owner/run/Stop/unmount lifecycle, this observer only | Implemented |
| 5 | Floating mirror, single connection, suppressed with full viewer | Implemented (original components) |
| 6 | Acknowledged exact Open, not a takeover answer, takeover coexistence | Implemented; dialog state is root's (H-D4). With a pending takeover this card yields to `DesktopBrowserCard` |
| 7 | loading/live/disconnected/unavailable/stopped, bounded, Retry revalidates | Implemented |
| 8 | Historical vs current, restart | Implemented (`projectSavedRun`, fresh mount validation) |
| 9 | Regression sources | Authored, **unrun** |
| 10 | Handoff | This document |
| — | Live card for computer (non-browser) work | Accepted in contract (`kind:'computer'`); depends on root emitting it |
| — | Takeover inside the inline card (original `TakeoverAsk` join) | Unsupported here by design: root's existing `DesktopBrowserCard` owns takeover |

Label note: the overlay keeps the original non-takeover label "Take control"; it opens root's dialog in
watch mode, where the dialog's own Take control acquires the lease.

## Regression sources (authored, NOT executed)

`apps/ui/lib/desktop/browser-run.test.ts`: strict parse/wrong shape; site sanitising; socket URL
validation; projection for no run/no screen/wrong owner/session/inactive/unselected/hidden/takeover;
saved-run historical vs current; check-before-ticket ordering; stale/stopped/unavailable never request a
ticket; run ending mid-ticket; error text redaction; expired ticket; dispose aborts + drops late reply;
obsolete attempt cannot overwrite; disconnect for this socket only, no auto reconnect, Retry revalidates;
connect watchdog; connected clears watchdog; hung check bounded; no stop/release/control surface.

`apps/ui/components/desktop/browser-runs/BrowserRunScreen.test.tsx` (fake viewer/transport, happy-dom):
passive viewOnly card + badge; fallback with no request for null/historical/wrong owner/session;
tab/visibility release and fresh revalidation; run change and Stop release only this viewer; late
ticket after unmount; stopped guest; disconnect + Retry; Open exact identity, rejection visible and
retryable without leaking; pending takeover suppression; floating mirror single connection and
suppression with full viewer, portal cleanup; restart fresh ticket; restart unavailable state.
