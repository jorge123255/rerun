# Round 29 E3 — C viewer source review and root corrections

Handoff `b5fc632e15311db78c876ea8fe8168391fb2a729` was cherry-picked as `9542900`. Root fixed the issues below in the coding checkout; C’s worktree remains untouched. This is **source integration only**. The engine routes/socket and dialog are deliberately not mounted or advertised until A’s actual runtime and B’s tools/durable takeover receipts are integrated and accepted.

Original design reference `a6d63a4`: AgentDesktopView, DesktopViewer, DesktopNotch, DesktopScreenLoader, ScreenMirror, ScreenCard, TakeControlOverlay, TakeoverAsk, DesktopDialog, engine desktop/bridge.ts, contracts/desktop.ts. The original frame/notch/loader remain reused; no host desktop control or files/terminal launchers are exposed.

## Root fixes

- Removed the engine syntax error.
- Removed the unsafe first-byte RFB filter. WebSocket frames are not RFB message boundaries. Watch now requires an explicitly server-enforced read-only endpoint supplied by A; a writable endpoint is refused before TCP connection. The actual guest configuration must still be verified during A integration.
- Replaced global tickets with bounded per-controller single-use tickets, exact owner/launch/generation and takeover lease binding. Required current-authority callback runs before/after issuance, at redemption and before forwarding input, with active authority monitoring. Exact UI origin and loopback peers are required at WebSocket upgrade.
- Added owned TCP/WS disposal, bounded FIFO/backpressure preserving byte order, per-owner Stop/revocation and full detach/close hooks. Stop never creates a guest and still attempts exact guest shutdown if release fails.
- Registered acquired leases before cancellation checks; failed release compensates by stopping the exact target. Failed cleanup retains ownership for retry. No-viewer expiry attempts cleanup. Exact finish receipts are replay-safe; an unknown/old lease returns `{url:null,expired:true}` without touching a current lease. Runtime finish must similarly return an expired outcome for a dead generation rather than pretending transient cleanup errors succeeded.
- Propagated cancellation client → UI server → engine, added late-lease compensation, retained failed release state and reacquired control on reconnect.
- Fixed manual Done to disconnect and close. Requested Done awaits B’s durable receipt and permits retry without releasing twice. Fixed the original overlay’s missing group styling and permitted a disconnected runtime to start/reconnect. Watch cannot paste or claim nothing was lost on disconnect.

## Current root integration contract

`createIsolatedViewer(service, authority)` in `apps/engine/src/desktop/isolated-viewer.ts` returns `{routes, attach, revoke, close}`. Root must mount `routes` under authenticated `/agents/:id/screen`, retaining the Mac route allowlist and engine key. Call `attach(server)` and retain its disposer; `close()` must run before shutdown. Bind revocation, disable/delete, Stop and session end to these hooks and A’s runtime shutdown/reconciliation.

The mandatory authority contains trusted `launchNonce`, exact `uiOrigin`, and `authorize(owner, mode, signal)`. It must freshly resolve exact coworker, enabled/deleting state and current browser/computer permissions; it must not use renderer-supplied grants. No default permissive authority exists. Grant promotion and this binding remain root-owned and are not in this partial integration.

A’s `withViewer` adapter must supply a trusted server-only `{host:'127.0.0.1',port,readOnly}` endpoint and enforce target generation. Watch requires `readOnly:true` backed by actual VNC server enforcement, including fragmented/combined keyboard, pointer and clipboard attempts. A can instead supply a proven read-only stream; root will adapt the transport. No frame-boundary filtering is acceptable.

The authenticated UI route remains `/api/desktop/agents/[agentId]/screen`, with view/takeover/takeover-finish/stop operations. Drive view requires the exact opaque takeover lease. Local owner mapping and authoritative engine enabled state are checked; the engine authority hook supplies current grant checks. Missing runtime returns an honest unavailable status. Internal generation/endpoint details stay server-side.

Mount `IsolatedScreenDialog` only when the runtime is actually available. B supplies `onHandBack(callId,url): Promise<void>` resolving only after its durable receipt succeeds. Requested takeover Skip and chat request presentation remain B/root integration. The dialog must not decide durable completion itself.

## Root checks

Root executed 12 engine transport/authority/lifecycle checks, six client session cancellation/reconnect checks and two dialog Done/receipt checks. These are local fixtures, not proof of a running Linux browser. Additional video/card checks run in the same acceptance batch. Types/lint/build status is recorded in the final acceptance report. Live E3 watch/drive/permissions, browser profile and pending-request restart acceptance remain pending A/B; do not check E3 off.
