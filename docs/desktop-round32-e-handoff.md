# Round 32 E — isolated Terminal and Files launchers

Source handoff only. No checks or native/guest acceptance executed. E3 remains partial.

Prepared worktree verified clean on `desktop/round32-computer-launchers`, exact base `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`. No other worktree modified. Read `docs/desktop-agent-assignment-standard.md`, the E3 checklist entry, root CLAUDE.md, accepted `docs/desktop-isolated-screen.md`, and current screen types/service/binding/input/frame/identity/tools/encoder, guest supervisor, Dockerfile/entrypoint and Docker arguments. This package has no Next.js, route or UI component edits, so no installed Next.js API is used.

## Verified original mapping

Inspected these actual files with git show at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/computer.ts`: `computer_open_app` (`browser`, `terminal`, `files`), URL only meaningful for browser, screenshot after opening, two-second open settle, run ownership, 200 ordinary/60 CLI screen actions, refusal while human drives. Original terminal checks shell grant; files checks filesystem grant. Desktop deliberately replaces those implied grants with independent launcher grants plus computer control.
- `apps/engine/src/desktop/apps.ts`: raise the last visible matching window before spawning; Thunar with workspace argument; Xfce Terminal with `--working-directory`; screen-owned child tracking. The host exec/spawn implementation is NOT imported. All app and X11 commands occur in the guest helper only.
- `apps/engine/src/desktop/apps.test.ts`: own workspace, last matching window (`222`), no duplicate process, browser takeover stays separate.
- `apps/engine/src/desktop/panels.ts`: original labels `Terminal`, `Files`, classes `Xfce4-terminal`, `Thunar`, and empty Openbox keybindings. Labels/classes retained; no new dock or settings design.
- `apps/engine/src/desktop/session.ts`: per-screen DISPLAY/environment and child lifetime. Here existing isolated-container identity owns the display; no Mac display/session module is imported.

## Changed files

- `packages/contracts/src/desktop-computer-launchers.ts`
- `apps/engine/src/desktop/computer-launchers/contract.ts`
- `apps/engine/src/desktop/computer-launchers/ports.ts`
- `apps/engine/src/desktop/computer-launchers/adapter.ts`
- `apps/engine/src/desktop/computer-launchers/authority.ts`
- `apps/engine/src/desktop/computer-launchers/store.ts`
- `apps/engine/src/desktop/computer-launchers/availability.ts`
- `apps/engine/src/desktop/computer-launchers/adapter.test.ts`
- `apps/engine/desktop-guest/computer_launchers.py`
- `apps/engine/desktop-guest/computer_launchers_test.py`
- `docs/desktop-round32-e-handoff.md`

## Public contracts and behavior

Root exports `desktop-computer-launchers.ts`. Model input for the two branches is EXACT `{app:'terminal'|'files'}`; `launcherRequestSchema` is strict. URL, command, executable, args, env, workspace/path fields and unknown keys reject before authority/control effects. Browser remains the existing branch, including its URL handling. Do not replace the browser schema/implementation with this two-app schema.

`DesktopComputerLauncherOperation` binds request ID to public agent/session/run IDs, generation and app. Internal `LauncherInvocation` adds the existing `ScreenTarget`; fingerprint includes that target's engine owner, launch nonce and generation, but raw engine identity is not returned in snapshots. The guest receives an opaque SHA-256 operation ID and fingerprint, app and mode (`launch`, `reconcile`, `verify`), plus the existing transport cancellation requestId. There is no command RPC or owner/path field in the guest protocol.

`DesktopComputerLauncherOutcome` returns public request/app/status/acknowledgement, plus fresh screenshot reference/dimensions if successful. No PID, window ID, path, process environment, container name or secret is exposed. Internal window IDs are validated inside the existing screen authority only. Errors are sanitized labels; do not forward arbitrary Python/process diagnostics into model output.

`createLauncherAuthority(read)` requires live enabled/nondeleting/active owner, exact public agent/session/run and exact screen target, computer permission, and the selected app's boolean permission. It never reads native shell/file/browser grants. Root chooses/catalogs final default-off grant IDs; this lane invents no persisted grant IDs.

## Exact injected host API

`createComputerLaunchers(ports: LauncherPorts, store: LauncherAttemptStore)` returns `{open(invocation, raw, stop): Promise<DesktopComputerLauncherOutcome>}`.

`LauncherPorts` in `ports.ts`:

```ts
authorize(invocation, app, signal): Promise<void>
withControl<T>(invocation, signal,
  work: (control: LauncherControl, signal: AbortSignal) => Promise<T>
): Promise<T>
publish(invocation, frame: ScreenShot, signal): Promise<string>
```

`LauncherControl`:

```ts
{
  target: ScreenTarget;
  check(signal: AbortSignal): Promise<void>;
  guest(body: {
    op: 'computer-launcher'; operationId: string; fingerprint: string;
    app: 'terminal'|'files'; mode: 'launch'|'reconcile'|'verify';
  }, signal: AbortSignal): Promise<unknown>;
  capture(signal: AbortSignal): Promise<ScreenShot>;
}
```

Root must mount `withControl` into the SAME existing `isolated-screen:${engineId}` tool lock, run screenOwners reservation, action counter and service `action()` boundary. No second service/container/runtime or independent lock is provided. Authorization is checked before entering control, again before guest/focus, after replies and immediately before/after frame publication. `check` must verify current target/run and human takeover every time. Root's lifecycle must abort the linked signal when grants/owner/run/generation change; checking only at tool discovery is insufficient.

The service currently keeps `action`, `current`, `guestCall` private. Root must expose an adapter closure from inside `createIsolatedScreenService` using them (not a public arbitrary-RPC API). Shape for the root-owned service integration:

```ts
// Only call this through the trusted launcher port after exact schema/admission.
withLauncherControl: (target, signal, work) =>
  action(target, signal, async (live, linked) => work({
    target,
    check: async () => {
      current(target);
      linked.throwIfAborted();
      if (live.lease || live.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused');
    },
    guest: (body, active) => guestCall(target, body, active).then(reply => reply.value),
    capture: active => captureWithinCurrentAction(target, live, active),
  }, linked))
```

`captureWithinCurrentAction` is root's extraction of the CURRENT `act` screenshot tail: `guestCall(op:'screenshot')`, numeric geometry validation, `viewOf`, update `live.screen`, nonempty PNG, `encodeJpeg`, JPEG `ScreenShot`. It must use the existing validated frame/encoder limits. Do NOT call public `act()` inside `action()`; that would nest the same lock. This lane's adapter also validates JPEG byte/dimension bounds and verifies the exact app window is still active AFTER capture, before publishing, so a late browser frame cannot masquerade as launcher success.

Root-owned `tools.ts` should extend only `computer_open_app` input choices, dispatch browser exactly as before, and dispatch terminal/files to `launchers.open`. Use trusted public identity mapping and stable unique invocation request ID derived from this real tool invocation (e.g. hash of agent/session/run/toolCallId). Reject a supplied URL even if undefined/empty on the terminal/files branch: apply the strict schema to the raw supplied fields. Tool callers cannot select run IDs or ScreenTarget. Do not count one call multiple times; use the existing CLI/ordinary screen action budget once at outer admission. Existing `ctx.screenshots.add(frame)` remains the screenshot placement mechanism. Return the existing `status:'done',screen:[w,h],screenshotId` tool shape for opened/focused outcomes. Other statuses return honest refusal/failure, no screenshot. Root's existing Codex bridge retains its screenshot delivery path; this package writes no host screenshot files.

## Durable operation adapter

`createLauncherAttemptStore(transaction: LauncherTransaction)` supplies actual reserve/submitted/settle behavior. Root injects its existing durable screen-operation transaction backend; this is not a second container database. `LauncherTransaction` is generic:

```ts
type LauncherTransaction = <T>(key: string,
  work: (current: LauncherAttempt|null) => {value: LauncherAttempt; result:T}
) => Promise<T>
```

It must atomically read/write and durably commit before resolving, serialize across processes, refuse corrupt/version-incompatible records, retain identity tombstones, and bound retained attempts per existing operation policy. Never implement it using only a Map in production. No migration/bootstrap file was edited. Root determines whether its existing screen ledger can hold the typed record or needs a NEW central migration. A `LauncherAttempt` is `{version:1,operation,fingerprint,operationId,phase:'reserved'|'submitted'|'settled',outcome}`. No raw process output or credentials enter it. Screenshot references are not persisted into the attempt: every visible success requires a new capture.

Only a newly reserved attempt may send `launch`. Any existing identity sends `reconcile`, even if the previous process died before sending. This sacrifices an uncertain unopened request rather than spawning twice. Changed app/run/generation/owner under one request ID refuses. Guest absence/starting/no window returns interrupted, never respawns. A new generation therefore cannot resurrect an old operation. Restart performs no launcher command; explicit retry reconciles only. Guest journal holds exact boot identity + app + fingerprint + PID/starttime/window and phase. Its tmpfs lifetime follows that guest; the host attempt ledger survives app restarts and remains authoritative about whether dispatch may happen.

## Guest integration and prerequisites (root only)

New helper import is side-effect free. Instantiate exactly ONE manager in the existing supervisor process after directories exist, NOT one per RPC CLI/client. It shares the supervisor's global `action_lock`, and its own nonblocking manager lock prevents accidental concurrent dispatch. Root creates `/home/rerun/workspace` and `/run/rerun/computer-launchers` as uid 10001, mode 0700, inside existing tmpfs mounts. These are guest-only directories, never host bind mounts. Do not use `/var/lib/rerun/profile`, host workspace, credentials folders or model request text as the launch directory. Startup checks require an existing real same-uid directory and refuse symlinks; no implicit mkdir occurs in the helper.

Root-owned Dockerfile changes:

- Install Debian bookworm packages `thunar`, `xfce4-terminal`, `x11-utils` (for xprop), retaining existing `xdotool`, Openbox, maim, Python and Xvfb.
- COPY `computer_launchers.py` alongside `guest.py` as a read-only image module.
- Keep existing no bind mounts/ports/socket/privileged execution. No package install occurs at tool time.
- Xfce terminal may require root's image integration to give uid 10001 an ordinary guest shell (`/bin/sh`) rather than the image user's current `/usr/sbin/nologin`; change only guest user shell, never Mac shell/native grants.
- Validate application daemon/window/PID behavior and package dependencies in the rebuilt guest. An unavailable binary explicitly returns app-missing; missing xprop/xdotool or X11 readiness is runtime-unavailable.

Example root-owned `guest.py` integration (do not construct manager at module import on RPC CLI):

```python
from computer_launchers import GuestComputerLaunchers, LauncherError
# In supervisor startup, one fresh boot identity independent of request text:
launchers = GuestComputerLaunchers(os.urandom(32).hex(), guest_env, cancelled)
# In dispatch(), under the existing action_lock:
if op == 'computer-launcher':
    try:
        return launchers.dispatch(request, client), b''
    except LauncherError as error:
        # Map error.state via fixed labels, never arbitrary exception text.
        raise GuestError('The isolated app launcher is ' + error.state + '.', refusal=True)
```

The helper tracks exact new Popen handles in `launchers.children`; root may supply `track_child` to a dedicated launcher child registry. Do NOT append launcher children to the existing generic `children` list without fixing `stop_children`'s assumption that its last element is Chromium. Guest/container Stop owns app lifetime. Cancellation kills only this operation's exact still-starting process group with matching PID starttime, never a previously open app. A newly visible app remains independent once opened. Daemonized/escaped descendants for which the startup leader has exited are not individually killed; full guest Stop removes their container. No host PID/name kill is supported.

Guest only executes absolute `/usr/bin/thunar <fixed guest workspace>` or `/usr/bin/xfce4-terminal --working-directory=<fixed guest workspace>` with `shell=False`, closed stdin and discarded app output. Query commands are fixed xdotool/xprop vectors, streamed up to 16 KiB, with 1-second per-query and overall 8-second startup/focus deadlines. At most 64 visible candidate windows and 256 attempts per guest. Exact class + same uid + matching executable + DISPLAY + PID starttime must match. The original last visible matching-window order is preserved. A successful process spawn is never reported before a visible owned window activates and two-second repaint settle completes. Host deadline is 25 seconds, with existing transport cancellation/drain acknowledgement. Timeout/abort do not return an old frame. Persistent journal pending files or incomplete startup records remain interrupted, never adopted by name.

## Availability, input policy and lifecycle

`launcherAvailability`, `createLauncherAvailability` and `LauncherUiCallbacks` expose secret-free original labels and permission-off/runtime-unavailable/app-missing/busy/timeout/interrupted/refused reasons. Root must supply read-only existing status/build capability data; opening Tools/settings/control panel must NOT call ensure/open, start Docker or create a guest. Package availability must come from actual installed image capability/status, not a hardcoded true. Passive viewer watch mode remains the existing read-only VNC stream; no second viewer/owner is introduced.

A launcher grant controls launch/focus, not general guest process isolation. Root must enforce foreground-input policy in existing `computer` and human-drive admission: while Terminal or Files is the active owned window, require its current launcher grant before sending model key/type/click/drag actions. Unknown/stale foreground ownership must refuse actions until safely resolved. On revoke, abort in-flight launcher/control operations and drain using existing guest cancellation ACK before permitting takeover/another action. Do not claim revocation closed a previously open user app. Existing browser permission semantics remain intact. Guest processes share that coworker's guest and can interact with its guest files/browser profile; this adds no host/native shell or workspace publication authority.

Full Stop/deletion/restart keeps the existing exact ScreenTarget/container-label cleanup. No separate app/container stop path is added here. Root must never use an old-generation PID/window from this journal to kill/focus a replacement guest. Cleanup uncertainty should close/refuse the current screen through the existing service logic, not announce success.

## Source regression coverage and status matrix

Authored but UNRUN `adapter.test.ts`: strict field refusal before effects, independent app/computer grants, changed request identity/run, lost response reconciliation, durable-factory restart, stale target, revoke, takeover, stale foreground screenshot, disabled/inactive owner, wrong coworker and cancellation. Guest fake-only tests cover fixed guest vectors, no request path/env injection, credential-free environment, last-window focus without spawn, exact window replay/conflict, stale PID/window preservation, restart without replay, app missing, cancellation without unrelated kill, fixed spawn and timeout cleanup of only its new handle. No commands in these test bodies were executed during this assignment.

| Slice | Status | Limit/dependency |
| --- | --- | --- |
| Strict canonical contract and independent authority | Implemented source | Root exports and selects default-off grant IDs |
| Fixed guest launch/focus and visibility checks | Implemented source | Root packages apps, creates guest directories and mounts dispatch |
| Duplicate/lost-response/restart reconciliation | Implemented source | Root durable existing screen transaction adapter required |
| Shared control and screenshot pipeline | Root dependent | Inject existing action/run lock, guest transport and capture closure |
| Availability/tool UI | Root dependent | Use exported labels/callbacks; no components edited |
| Foreground input after revoke | Root dependent | Existing computer/drive admission must enforce current app permission |
| Host Terminal/Finder/commands/mounts | Unsupported | No host execution imports or filesystem/publication RPC |
| Arbitrary commands/args/env/paths, native shell/writeback | Unsupported | Strict refusal before effects |
| Replaying uncertain startup, killing an already-open user app | Unsupported | Interrupted outcome/preserve independent window |
| Per-descendant containment beyond existing guest | Unsupported | Existing container Stop is the boundary |

No test, typecheck, lint, build, package install, Docker, guest command, UI, provider/API/network service or Keychain execution. No push, merge, publication or deployment. Root runs all execution checks, repairs, guest rebuild and Mac/full-restart acceptance. No shared checklist change or full-E3 completion claim.
