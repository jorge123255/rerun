# Round 34 E — isolated guest shell handoff

Base: `ae816049ccf63cb0bfa3309451cc9c04e63cafb5`.

Source handoff only. Root owns integration, repairs, all checks, Docker/package installation, permissions, provider dispatch, and native/restart acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/shell.ts`: bounded command/timeout, stdout/stderr, `[stderr]` presentation, failure/timeout text and workspace cwd.
- `apps/engine/src/tools/builtin/self.ts`: original `tool_install` runs npm in the coworker workspace so the package is subsequently usable through shell. Install success alone is not execution evidence.
- `apps/engine/src/tools/builtin/sub-run-watch.ts`: output bounds, cancellation and secret-shaped input redaction.

Current isolated-screen sources supply labeled container/volume ownership, unprivileged guest execution, `rerun-rpc` framing, cancellation tombstones, minimal guest environment and container-generation checks. Round33’s reviewed `tool_install` contract supplies exact package targets, guest identity and install evidence.

The local adaptation uses a separate default-off `guestShell` permission. It does not infer Terminal/browser/Files grants, permit host execution, or treat installation as proof of usability.

## Exported owned surface

- `packages/contracts/src/desktop-guest-shell.ts`: bounded input, identity, request, result, receipt and package evidence.
- `apps/engine/src/desktop/guest-shell/types.ts`: authority, package authority, transport and receipt-store interfaces.
- `transport.ts`: `createDesktopGuestShellTransport` for `guest-shell`, `guest-shell-inspect` and existing `cancel` RPC operations.
- `service.ts`: `createDesktopGuestShellService` for execute/inspect/stop/read.
- `tools.ts`: `desktopGuestShellTools`, `desktopGuestShellStop`, `formatDesktopGuestShellResult`.
- `apps/engine/desktop-guest/guest_shell.py`: concrete unprivileged guest process manager with create-only receipts, minimal environment, exact cwd validation, bounded readers, process-group cancellation and package evidence lookup.
- `apps/engine/desktop-guest/guest.py`: connected `guest-shell` and `guest-shell-inspect` RPC operations plus ownership-scoped cancellation.

No Dockerfile, entrypoint, central migration, registry, grant, screen authority or Round33 install source was edited.

## Required root integration

### Contract and persistence

Export centrally:

```ts
export * from './desktop-guest-shell.js'
```

Add a central migration for a `desktop_guest_shell_requests` table with `request_id` primary key, full invocation identity, command/input fingerprint and receipt JSON, plus created/updated timestamps. Store only bounded receipts and package evidence hashes, not credentials or host environment. A receipt includes `fingerprint` so changed command/cwd/packages under one request ID refuse.

### Authority and transport

```ts
const transport = createDesktopGuestShellTransport(dockerClient)
const service = createDesktopGuestShellService({
    authority: (identity, signal) =>
        authorizeDesktopGuestShell(runtime, identity, signal),
    transport,
    store: desktopGuestShellStore(db),
    packageAuthority: (guest, packages, signal) =>
        reviewedDesktopPackageEvidence(runtime, guest, packages, signal),
    publicText: desktopPublicText,
})

const tools = desktopGuestShellTools(ctx, {
    authority: serviceAuthority,
    transport,
    store: desktopGuestShellStore(db),
    packageAuthority: reviewedDesktopPackageEvidence,
    publicText: desktopPublicText,
})
```

`authorizeDesktopGuestShell` must validate current local coworker/session/run/tool invocation, the separate `guestShell` grant, active run, exact container generation and workspace fingerprint. It must reject deleted/disabled owners, revoked grants, replacement containers and active human takeover. It must not treat browser/computer/private-file grants as shell permission.

`reviewedDesktopPackageEvidence` reads the Round33 reviewed install snapshot for the same guest. Every requested exact package target must have one installed row with `manifestSha256` and `lockSha256`; missing, partial, changed or different-guest evidence refuses before reservation. No package is installed by this feature.

`desktopPublicText` applies the existing safe-output policy to stdout/stderr and safe errors. Minimal environment prevents inherited provider credentials, but output can still contain credential-shaped or private text and needs that projection.

### Guest image and dispatcher

Root must copy `apps/engine/desktop-guest/guest_shell.py` into the isolated image alongside `guest.py`. The new dispatcher imports it. Do not replace the existing entrypoint or build/start the image in this lane.

`GuestShellManager` uses `/var/lib/rerun/profile/workspace` inside the existing owned volume, never a host mount. Its minimal environment contains PATH/HOME/LANG/LC_ALL/RERUN_WORKSPACE/NODE_PATH only. It uses `/bin/sh -c` as the unprivileged guest user, with `start_new_session=True`, bounded readers, process-group termination and create-only receipt files under `.guest-shell-receipts`.

### Stop and lifecycle

```ts
await desktopGuestShellStop(ctx, dependencies, originalRequestId)
```

Root calls this for Stop, disable, deletion, grant removal or container replacement. It uses the original request ID, not the current run ID as a substitute. Cancellation never stops a sibling or a replacement container. Existing execution is inspected after cancellation; uncertain outcomes remain interrupted/unavailable rather than executing again.

`desktopGuestShellStop` uses the existing cancel RPC and guest receipt. Definite failures may be retried only with a new request ID.

## Threat and limitations notes

- Reviewed npm packages remain arbitrary code, now inside the isolated guest. They receive no host filesystem, Docker socket, host environment or implicit host network/credential bridge.
- Guest cwd is relative to `/var/lib/rerun/profile/workspace`; absolute paths, `..`, backslashes and links are refused. Package lookup reads only reviewed evidence and does not mutate installation state.
- Output is bounded at 50,000 characters per stream. Exceeding the cap is a failure, not a silent success or valid full output.
- Timeout/cancel kills only the child process group. The guest manager does not delete user files, installed packages, history or the profile volume.
- Existing human/browser/Files capability and active human takeover remain authoritative and are not bypassed by a terminal command.
- Receipt and inspection do not prove a provider read arbitrary file contents; they prove only the actual guest process result.
- The standalone source does not supply Docker build, package installation, a grant registry entry, central migration, provider dispatch or native QA.

## Root-only harmless installed-package QA scenario

Root performs this only after integrating the authority, image, receipt store and grant:

1. Use the existing reviewed tool-install flow to approve `is-number@7.0.0` in the isolated guest and confirm its installed manifest/lock evidence. Do not use a host package or host Node runtime.
2. Call `shell_exec` with `node -e "const isNumber=require('is-number'); console.log(isNumber(42), isNumber('x'))"`. Expected guest output: `true false`, exit 0, status `done`.
3. Call `node -e "console.log(require.resolve('is-number'))"` and verify the path is under `/var/lib/rerun/profile/node_modules`, not a host path.
4. Run `pwd` in the default guest cwd and `printf ok` in an existing relative subdirectory. Verify cwd is confined to the owned workspace.
5. Start a short-lived output-producing command, Stop it with the original request ID, and confirm `cancelled`, no second execution and no sibling impact.
6. Use a timeout command and verify `timeout`, bounded stdout/stderr and process-group cleanup.
7. Lose the response after launch and call inspect with the same request ID. Reconcile the existing result; do not relaunch. Then restart the guest and read the persisted receipt without executing it again.
8. Request a package not present in reviewed evidence and verify refusal before process launch. Request a different guest/replacement and verify refusal without cleanup of user files or installed packages.

No part of this scenario was executed in this lane.

## Implemented / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Command/receipt contract and fingerprint | Implemented | Central export and migration |
| Guest process launch and bounded output | Implemented | Guest image copy and real process QA |
| Minimal environment and cwd confinement | Implemented | Container authority and workspace validation |
| Timeout, Stop and process-group cleanup | Implemented | Lifecycle and cancellation QA |
| Duplicate/lost-response/restart reconciliation | Implemented | Durable receipt store and restart QA |
| Reviewed package lookup | Implemented | Round33 install evidence and exact package QA |
| Separate default-off permission | Tool factory implemented | Grant registry and current-run authority |
| Host execution/host environment fallback | Explicitly unsupported | Must remain unsupported |
| Automatic second execution after uncertainty | Explicitly refused | Must remain unsupported |
| Docker/package installation/native acceptance | Not run | Root performs all checks |

## Regression sources authored and unrun

- `apps/engine/src/desktop/guest-shell/contract.test.ts`: command/cwd/timeout/package validation.
- `service.test.ts`: reservation, duplicate/conflicting requests, evidence refusal, cancellation, interruption and Stop.
- `transport.test.ts`: exact RPC identity, inspection and cancellation.
- `apps/engine/desktop-guest/guest_shell_test.py`: minimal environment, nonzero exit, duplicate receipt, timeout process group, output cap, cwd links, reviewed evidence and cancellation.

No tests, typecheck, lint, builds, installs, servers, provider/API/network calls, Docker, package installation, host commands, capture/playback, Keychain, push or merge were run. Root execution and native/restart acceptance remain pending.
