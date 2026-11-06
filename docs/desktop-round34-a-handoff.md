# Round 34 A — Live computer panel and app launch controls (E3)

Worktree `round34-screen-following`, branch `desktop/round34-screen-following`, verified clean at exact base `9c8a91e187642dbf103d65887bb589b5147c8305` before editing. No hooks configured. **Source only: nothing was run** (no tests, types, lint, build, servers, Docker, Mac UI). Not accepted; E3 not marked.

## Original mapping (pin a6d63a4b542674ddd002e51b39ba0df6e0807bcc)
| Original | Desktop |
|---|---|
| AgentChat L810-895: `screenShown = (showLoader && runUsesScreen(messages)) \|\| takeoverAsk`, ChatScreen as last block | `presentComputerPanel` — trusted `liveScreen` replaces message scan (history never opens); pending takeover left to accepted `DesktopBrowserCard` |
| ChatScreen: `active && selected` gate, ScreenCard + FloatingScreen portal, Take control → openDesktop | `ComputerPanel` reuses accepted `BrowserRunScreen` (same ScreenCard/FloatingScreen/DesktopViewer, view-only) |
| useAgentScreen watch ticket per mount | accepted `createBrowserRunObserver` + `screenClientWatchTransport` (requireRunning) |
| DesktopNotch Browser/Files/Terminal order, icon-sm ghost, labels | `ComputerLaunchControls` (same order/icons/labels; disabled reason as title) |
| computer.ts `computer_open_app` browser/files/terminal; human driving blocks | Browser → root full viewer (existing drive/lease); Terminal/Files → Round32 E launcher via H-A1; busy while driving |
| desktop.store close/openDesktop | Hide (X / Escape) = per-owner dismissal; "Show screen" reopens; root dialog keeps lease |

## Files
- `apps/ui/lib/desktop/computer-panel/{contract,controller,launch,adapters}.ts` (+ `controller.test.ts`, `launch.test.ts`, `adapters.test.ts`)
- `apps/ui/components/desktop/computer-panel/{ComputerPanel,ComputerLaunchControls}.tsx`, `useComputerPanel.ts` (+ `ComputerPanel.test.tsx`)
- this doc. No barrels (root-owned).

## Contract
`ComputerPanelOwner = {workspaceId, agentId, sessionId, runId, generation(32 hex)}`; `ComputerPanelProjection` (current trusted run, generation, coworker enabled/deleted, takeover, runtime kind, grants {computer, browser, terminalLaunch, filesLaunch}, capability {terminalInstalled, filesInstalled}, humanDriving); `ComputerPanelPorts {checkCurrentRun, transport, openFullViewer, launchApp, revalidateOwner}`; `MissingComputerPanelAuthority('H-A1'|'H-A2')`. Modes model/watch/drive are distinct; drive only via root's IsolatedScreenDialog lease.

## Adapters
Concrete (accepted routes): `readTrustedCurrentRun`, `httpCurrentRunCheck` (GET `.../sessions/:sid/browser-run`), `screenClientWatchTransport`, `runtimeFromStatus` (GET `/api/desktop/agents/:id/screen`), `createComputerPanelProjectionReader(readFacts)`, `createOwnerRevalidation(readFacts)`, `createHttpHumanLauncher()` (client for H-A1).
Missing authorities (refuse, never fake success):
- **H-A1** human launcher route: `POST /api/desktop/agents/:agentId/sessions/:sessionId/computer-launcher {requestId, runId, generation, app:'terminal'|'files'}` → `DesktopComputerLauncherOutcome`, reusing Round32 E attempt store (same requestId reconciles, never respawns), `createLauncherAuthority`, `withControl` (refuse while human drives), launcher grants. 404 ⇒ `MissingComputerPanelAuthority`.
- **H-A2** root facts `ReadComputerPanelRootFacts(agentId, sessionId, signal)` → `{workspaceId, generation (ScreenTarget.sessionGeneration), coworker, takeover (accepted takeover view), grants, capability (createLauncherAvailability read)}` — read-only, must not ensure/start Docker.

## Root mount (DesktopConversation, replacing the DesktopBrowserRun line ~1106)
```tsx
const readProjection = useMemo(() => createComputerPanelProjectionReader(readPanelFacts), [])
const ports = useMemo<ComputerPanelPorts>(() => ({ checkCurrentRun: httpCurrentRunCheck, transport: screenClientWatchTransport,
  revalidateOwner: createOwnerRevalidation(readPanelFacts),
  launchApp: H_A1_MOUNTED ? createHttpHumanLauncher() : missingHumanLauncher,
  openFullViewer: async owner => { if (owner.agentId !== agent.id || owner.sessionId !== sessionId) throw new Error('ended'); setScreenOpen('manual') } }), [agent.id, sessionId])
{generating && sessionId && !takeover ? <ComputerPanel key={sessionId} agentId={agent.id} sessionId={sessionId} active={active} selected={active}
  fullViewerOpen={screenOpen !== null} readProjection={readProjection} ports={ports} humanLaunchMounted={H_A1_MOUNTED}
  scroller={scroller} floatingHost={scroller?.parentElement ?? null} onReturnFocus={() => composerRef.current?.focus()}
  fallback={<div className="text-sm text-muted-foreground">{agent.name} is working…</div>} /> : /* existing */}
```
Board/camera, drafts, selected chat and tabs are untouched: the panel only reads props and calls ports.

## Lifecycle
Poll 2 s only while visible; abort on session change/unmount; late/mismatched replies dropped. Dismissal per exact owner+takeover (in memory: restart shows a still-live run again, as original; no lease is ever resumed — the panel never holds one). New run/generation = fresh observer & launcher. Launch: revalidate owner → port; duplicate clicks dropped; lost ACK/interrupted → `uncertain`, blocks other apps, retry keeps requestId; missing authority → truthful failure. Runtime absent (Docker/image/stopped/disconnected) → fallback + reason; disabled/deleted coworker → hidden. Escape/X hide and return focus; reduced motion via existing FloatingScreen; short window `max-height:560px` narrows card.

## Regressions (authored, UNRUN)
`controller.test.ts` (owner change, history, takeover, runtime, dismissal replay, grants/capability), `launch.test.ts` (duplicate, lost ACK identity, revalidation, missing authority, stale reply), `adapters.test.ts`, `ComputerPanel.test.tsx` (grant reasons, no lease on open/hide, Escape/reopen, stale session).

## Matrix
| Behavior | Status |
|---|---|
| Trusted-run gated inline screen, floating mini, watch-only | Implemented (reuses accepted viewer) |
| Browser launch / Take control → existing drive lease | Implemented via root `openFullViewer` |
| Terminal/Files human launch | Dependent on H-A1 (client ready; refuses until mounted) |
| Generation/grants/capability/coworker facts | Dependent on H-A2 |
| Dismiss/reopen, duplicate suppression, a11y, short window | Implemented |
| Paste/Done in drive | Existing IsolatedScreenDialog (unchanged) |
| Persisting dismissal across restart, Mac app launch | Unsupported (intentional) |
