# Round 33 E — reviewed tool installation in the isolated computer

Source handoff only. Root integration, guest implementation, checks and native acceptance remain pending.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/self.ts` — original literal `npm install --no-fund --no-audit -- <packages>` argv, workspace cwd, Improve itself gate, 300-second bound and 20,000-character output.
- `apps/engine/src/tools/builtin/self.install.test.ts` — no shell, exact package arguments, flag refusal and bounded failures.
- `apps/ui/components/agent/AgentPanelTools.tsx` — original Improve itself controls and capability presentation.
- `packages/ui/src/chat/ActionApprovalBlock.tsx` — original approval rows, Approve/Not now, decline reasons and responsive details.

Round 32 E `docs/desktop-round32-e-handoff.md` and accepted isolated-screen identity, binding, service and transport were inspected. This package reuses the same `ScreenTarget` generation, action lock, linked cancellation and guest cancellation acknowledgement. It never invokes host npm or an unconstrained shell.

## Canonical contract and exports

`packages/contracts/src/desktop-tool-install.ts` defines:

- `desktopToolInstallInputSchema`: 1–8 unique exact `name@version` targets, including scoped names and semver prerelease/build forms. Flags, ranges, tags such as `latest`, URLs, paths, git specs, whitespace, shell text and ambiguous names refuse before authority or guest effects.
- `DesktopToolInstallRunIdentity`: local agent/session/run/tool-call, proposal revision and exact guest/workspace identity.
- `DesktopToolInstallSnapshot`: operation ID/revision, public source identity, pending/approved/installing/installed/partial/failed/declined/cancelled/uncertain/interrupted state, per-package outcomes, evidence hashes, bounded output and `isolated-guest-only` availability.
- `DesktopToolInstallDecision` and `DesktopToolInstallInspect` actions with stable request IDs and expected revisions.
- `DesktopToolInstallAuthority`, `DesktopToolInstallGuestAdapter`, `DesktopToolInstallStore`, `DesktopToolInstallPorts` and secret-free capability view.
- `desktopToolInstallOperationId` and `desktopToolInstallGuestId`: SHA-256 identities; public snapshots contain no engine ID, PID, container name, credential or host path.

`apps/engine/src/desktop/tool-install/` exports the lifecycle service, model proposal tool, approval/outcome projections and activity metadata. `apps/ui/lib/desktop/server/tool-install/` exports the durable store, session service, schema and HTTP binder. `apps/ui/lib/desktop/tool-install-client.ts` exports the bounded client and race error. `DesktopToolInstallCard` and `useDesktopToolInstall` provide the original approval interaction and history/recovery presentation.

## Lifecycle behavior

- Proposal reserves exact intent before execution and renders the original approval row. No package executes on proposal, mount, history read or restart.
- Approval and decline both recheck Improve itself, the distinct install grant, owner/run and guest identity. Only an approved current `pending-approval` revision can execute.
- Installation records approved and installing snapshots before guest execution. A second authority check occurs immediately before `execute`.
- Per-package `installed` requires both manifest and lock SHA-256 evidence. Missing rows/evidence, partial installs and uncertain exits cannot look complete.
- Exact concurrent decisions coalesce; conflicting decisions refuse. Different operations remain independent and share the existing guest action lock.
- Guest/process/ACK failure produces uncertain rather than automatic retry. Explicit `inspect` uses the same owned guest and never invokes `execute`. Restart/history performs zero new installs.
- Output is sanitized and bounded at 20,000 characters. Packages are described only as usable inside the isolated guest/workspace, never as host Codex/native imports.

## Precise root wiring

### Contract, grant and registry

Export `desktop-tool-install.js` from the central contract index. Add a default-off Rerun `toolInstall` grant, independent of native shell and other launchers. Keep `selfImprovement.enabled && allowToolInstall` as the second required gate.

Mount the model tool beside the other desktop tools:

```ts
import { desktopToolInstallTools } from '../desktop/tool-install/tool.js'

Object.assign(tools, desktopToolInstallTools(ctx, desktopToolInstallPorts(ctx)))
```

`authority(identity,signal)` must validate current enabled/not-deleting owner, both permissions, current session/run/tool-call and the exact current `ScreenTarget`/guest workspace fingerprint. `DesktopToolInstallPorts` composes that authority, the guest adapter and the durable outcome store.

### Guest protocol and execution

Use the existing isolated-screen `action(target,signal,...)` boundary and cancellation path, not a new runtime or arbitrary guest RPC:

```ts
const guest: DesktopToolInstallGuestAdapter = {
    execute: (identity, signal) => withToolInstallControl(identity.guest, signal, control =>
        control.call({
            op: 'tool-install', mode: 'install', operationId: await desktopToolInstallOperationId(identity, packages),
            packages: identityPackages(identity),
        }, signal)),
    inspect: (identity, signal) => withToolInstallControl(identity.guest, signal, control =>
        control.call({ op: 'tool-install', mode: 'inspect', operationId: identityOperationId(identity), packages: identityPackages(identity) }, signal)),
}
```

The guest request must contain only the fixed operation, opaque operation ID, mode and exact packages. No argv/env/working-directory field comes from model text. Guest execution uses a fixed `/usr/bin/npm install --no-fund --no-audit -- <packages>` vector, `shell:false`, closed stdin, the existing guest-only workspace, a 300-second bound and sanitized bounded output. Root validates real manifest/lock bytes and returns their SHA-256 values, never fabricated evidence.

The Docker image needs npm and a valid package workspace already present. No host bind mount, port, credential folder, host npm, host package directory or native tool registration is added. Guest loss/cancellation follows the existing cancel-acknowledge/drain protocol.

### Persistence and routes

Add `desktopToolInstallSchema` from `apps/ui/lib/desktop/server/tool-install/schema.ts` through root’s central migration/bootstrap. `desktopToolInstallStore(db)` implements atomic reservation and monotonic completion over `desktop_tool_installs`; it is not a parallel chat database.

Mount the binder:

```ts
const handler = desktopToolInstallHttp(runtime, desktopToolInstallPorts(ctx))
// GET and POST /api/desktop/sessions/[sessionId]/tool-install
```

GET takes `operationId` and only reads. POST accepts only the canonical `decide` or `inspect` action. `decide` executes only after current approval; `inspect` is explicit recovery. No other operation is accepted.

### Approval, history, attention and Settings

Render `DesktopToolInstallCard` from the structured `tool_install` snapshot:

```tsx
<DesktopToolInstallCard sessionId={sessionId} operationId={snapshot.operationId} active={active} />
```

Use `desktopToolInstallApprovalItems` for the original approval labels and `desktopToolInstallOutcomeText` for model/history text. `desktopToolInstallAttention` supplies pending-review/installing/uncertain summaries for root’s attention mount. Session history uses `outcomes.list(sessionId)` and never calls the guest. Settings readiness uses `DesktopToolInstallCapabilityView`; opening the panel performs no installation or guest startup.

## Implemented / dependent / unsupported matrix

| Area | Status | Dependency or unsupported scope |
| --- | --- | --- |
| Exact package validation and reviewed identity | Implemented in source | Root exports the contract |
| Original approval presentation | Implemented in source | Root mounts the operation in chat/attention |
| Separate Improve/install permissions | Port implemented | Root supplies grant and current authority |
| Guest npm execution and evidence | Root dependent | Guest image, fixed adapter, actual manifest/lock validation |
| Durable reservation and monotonic outcomes | Implemented in source | Root supplies central migration/bootstrap |
| Duplicate/conflicting/lost ACK handling | Implemented in source | Root supplies existing guest/action/outcome authority |
| Cancellation and explicit recovery | Implemented in source | Root supplies linked guest cancellation and inspect adapter |
| History without automatic reinstall | Implemented in source | Root mounts saved snapshots |
| Host package import or native tool availability | Unsupported | Packages remain guest-only |
| Arbitrary shell/URL/path/range/latest specs | Unsupported | Strict canonical target refusal |
| Static “safe package” guarantee | Unsupported | Reviewed package scripts are execution |
| Native/build/full-restart acceptance | Root dependent | No executable check was performed here |

## Authored, unexecuted regressions

- `contract.test.ts`: exact/ambiguous/hostile package strings, duplicates and operation identity changes.
- `service.test.ts`: proposal without execution, approval/decline, stale/forged authority, incomplete evidence, concurrent/conflicting decisions, lost ACK, explicit inspect, cancelled/guest-loss and history without execution.
- `tool.test.ts`: proposal-only tool, invalid input before effects and both permission gates.
- `store.test.ts`: reservation/completion/history, identity/revision conflicts and interrupted null reservation recovery.
- `tool-install-client.test.ts`: wrong-owner reads, stable decision UUIDs, authoritative revision races, explicit inspect, disposal and malformed responses.
- `DesktopToolInstallCard.test.tsx`: original approval, exact scope, explicit inspect and per-package evidence/availability.

No tests, typecheck, lint, builds, dependency installation, servers, packaging, UI actions, Docker, live APIs/providers, npm execution or Keychain access was performed. The installed Next.js documentation directory was absent. Root must run all checks and repair any defect; no checklist or installed acceptance claim is made.
