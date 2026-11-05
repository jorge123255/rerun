# Round 29 E3 — isolated desktop viewer and takeover (lane C)

Original sources at `a6d63a4`: `apps/ui/components/desktop/AgentDesktopView.tsx`, `DesktopViewer.tsx`, `DesktopNotch.tsx`, `DesktopScreenLoader.tsx`, `ScreenMirror.tsx`, `ScreenCard.tsx`, `TakeControlOverlay.tsx`, `apps/ui/components/chat/TakeoverAsk.tsx`, `apps/ui/components/dialogs/DesktopDialog.tsx`, `apps/engine/src/desktop/bridge.ts`, `packages/contracts/src/desktop.ts`.

## What this lane adds

- `apps/engine/src/desktop/isolated-viewer.ts` — engine adapter outside A/B directories. `isolatedScreenRoutes(service)` serves `GET /status`, `POST /view`, `POST /takeover`, `POST /takeover/finish`, `POST /stop` under `/agents/:id/screen`; `attachIsolatedViewerBridge(server, service)` upgrades `ISOLATED_VIEWER_WS_PATH` (`/desktop/isolated-viewer-ws`) with single-use expiring tickets bound to owner + launch nonce + session generation + strict mode. Watch mode drops RFB input frames server-side — the original `bridge.ts` forwards input in watch mode and is deliberately not copied.
- `apps/ui/lib/desktop/server/screen/service.ts` — resolves the local coworker to `{ engineAgentId, launchNonce }` server-side (never client-supplied), enforces enabled/not-deleting, calls the engine routes with the loopback apiKey, and returns a `ws://127.0.0.1` viewer URL. Target details (generation, lease) stay server-side except the opaque lease round-trip.
- `apps/ui/app/api/desktop/agents/[agentId]/screen/route.ts` — authenticated discriminated-union POST (`view`/`takeover`/`takeover-finish`/`stop`) plus GET status, all through `desktopRoute`.
- `apps/ui/lib/desktop/screen-client.ts` — typed client fetchers.
- `apps/ui/components/desktop/isolated-screen/IsolatedScreenDialog.tsx` — preserves the original dialog/frame/notch/loader and Done flow, reusing `DesktopViewer`, `DesktopNotch`, `DesktopScreenLoader`, `DesktopDialog`, `TakeControlOverlay`, `EmptyState`. Adds truthful `unavailable`/`disconnected` states, watch default, take-control overlay, fresh ticket per reconnect, and release of the takeover lease on unmount/mode switch.
- `apps/engine/src/desktop/isolated-viewer.test.ts` — ticket single-use/expiry/mode/revocation coverage.

## Mac adaptations vs the original

- Tickets are engine-held random tokens (single-use, 60 s) instead of the original HMAC `mintDesktopTicket`, because owner + launch nonce + generation binding needs server state; the original signature-only ticket cannot express single-use or generation.
- Watch enforcement moved into the pipe (`watch` drops key/pointer frames), fixing the original bridge's watch-mode input leak.
- Takeover lease is returned to the renderer only as an opaque string required to finish; Done/Skip durable receipt identity stays with lane B — `onHandBack(callId, url)` is the seam.
- No files/terminal launchers and no host desktop control: `DesktopNotch` gets `launchers={false}`; the only drive path is the takeover lease.

## Root integration fragments

Engine bootstrap (`apps/engine/src/cli/commands/run.ts` next to `attachDesktopBridge`, and wherever the desktop engine server is created):

```ts
import { isolatedScreenRoutes, attachIsolatedViewerBridge, type IsolatedScreenService } from '../../desktop/isolated-viewer.js'
// inside createServer/api mounting:
api.route('/agents/:id/screen', isolatedScreenRoutes(isolatedScreenService))
// after server listen:
attachIsolatedViewerBridge(server as Server, isolatedScreenService)
```

`isolatedScreenService` is lane A's `IsolatedScreenService` from `apps/engine/src/desktop/isolated-screen/index.ts`; the adapter's `IsolatedScreenService` interface mirrors the round-29 agreement (status/ensure/navigate/startTakeover/finishTakeover/stop/withViewer). One seam to confirm against A's landed signature: `withViewer`'s connect callback is typed `(endpoint: { host: string; port: number }) => void` — adjust `pipeToIsolatedVnc` if A hands back a stream or unix socket instead.

UI mounting (root-owned `DesktopApp`/`DesktopConversation`/chat card): render `IsolatedScreenDialog` with `agentId`, `title`, optional `takeover={{ callId, url, reason }}`, `onOpenChange`, and `onHandBack(callId, url)` forwarding to B's durable request adapter. For the chat-position card, reuse existing `ScreenCard`/`TakeoverAsk` with a viewer node that requests a `watch` ticket via `requestDesktopScreenTicket`.\n
Revocation wiring (root): coworker disable/delete, permission revocation, Stop, session end and Quit should call `desktopScreenStop(runtime, agentId)` (releases lease, drops tickets via `revokeIsolatedViewerTickets`) and `service.stop(target)`; renderer sockets abort on unmount already.

## Remaining limits

- `withViewer` endpoint shape and A's service are unverified until A lands; route/service compile against the agreed interface only.
- Takeover Done/Skip durable receipts are B's; this lane supplies `onHandBack` and finish-takeover transport only.
- No tests/typecheck/lint/build/packaging/native QA run in this lane — root executes all verification.
