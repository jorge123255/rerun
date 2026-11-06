# Round 36 — Lane H: Original Servers dialog and machine connection UI

This lane ports the original Rerun Servers dialog and its machine connection lifecycle into the
Mac desktop app, consuming the canonical machine/transition contract published by lane G
(`desktop/round36-remote-machine-runtime`). It owns the browser client, the panel hook, the dialog
and its subcomponents, and the regression sources. It delivers **activation fragments** for root —
no central runtime, supervisor, IPC/preload, contracts barrel, database ladder, DesktopApp or route
file was touched. This handoff is not an acceptance report; root runs all checks.

## Original Rerun references

Reference commit: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/ui/components/dialogs/ServersDialog.tsx` — dialog shell (`DialogContent
  flex flex-col sm:max-h-[85dvh] sm:max-w-lg sm:overflow-hidden`), `ScrollFade
  -mx-1 min-h-0 flex-1 px-1 py-1`, `SkeletonList rows={2}`, `POLL_MS 3000`,
  SectionTitle "Enter a server by hand", Address/API key `Input` labels and placeholders, masked
  key (`type="password"`), ghost Back + Connect buttons, "This workspace's server" row with
  `Badge` tone green/red size xs `glow={false}`, `PanelRow` title/meta/description/actions,
  ConfirmDialog remove gate.
- `apps/ui/app/api/_actions/servers.actions.ts` + `apps/ui/app/api/_services/servers.service.ts` —
  original server status/connect/remove semantics (one server per workspace, attach refuses when a
  server already exists, remove confirmation, hosted pool never shown).
- `apps/ui/components/layout/WorkspaceSwitcher.tsx` — the mount point and the original menu item
  copy (`ServerIcon` + "Servers", `SERVERS_ENABLED` gate), `{SERVERS_ENABLED && <ServersDialog
  open={serversOpen} onOpenChange={setServersOpen} />}`.
- Building blocks reused as-is: `ConfirmDialog`, `SkeletonList`, `PanelRow`/`PANEL_CARD`, `Input`,
  `Button`, `Badge`/`ScrollFade` primitives, `Loader2Icon`/`ServerIcon`.

## Published dependent contract (lane G, read-only)

Canonical schema: `packages/contracts/src/desktop-remote-machines.ts` in lane G's worktree
`/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round36-remote-machine-runtime`
(**DESKTOP_REMOTE_MACHINES_VERSION = 1, currently uncommitted in G's worktree** — root integrates
it). It imports `desktopWorkspaceIdSchema` and `desktopWorkspaceSwitchPhaseSchema` from Round35
`packages/contracts/src/desktop-workspaces.ts` at commit
`052f6f66f8f8eaca27d5ea878d2cf3024e617dc0`. Neither export is in the contracts barrel today; root
adds both.

Contract surface consumed here: `desktopRemoteActorSchema` (installId/workspaceId/launchNonce/
rendererEpoch), `desktopRemoteConnectionSchema` (connectionId/revision/address/identity/
credentialConfigured/removable/health), `desktopRemoteReceiptSchema` (kind pair|replace|select|
remove|health, phase = Round35 switch phases, `requiresRecovery`, `effectGeneration`),
`desktopRemoteSnapshotSchema` (revision/connection/selected/openReceipt), `desktopRemoteCommandSchema`
(read/reconcile/receipt/cancel + recover with `resume: true` + `expectedReceiptRevision`, pair with
`expectedRevision: 'unconfigured'`, replace/select/health with exact revision, remove with
`confirmation: 'Remove'`), `desktopRemoteResultSchema` (ok true + snapshot/receipt; refusal codes
invalid/stale/busy/unavailable/unsupported/auth_needed/identity_changed/authority_missing/
uncertain/cancelled/storage_full), `REMOTE_MACHINE_COPY`, `DESKTOP_REMOTE_MACHINE_LIMITS`
(requestMs 10000, operationMs 60000, receipts 128).

## Inventory (owned paths)

`apps/ui/lib/desktop/remote-machines/`
- `remote-machines-client.ts` — browser client for `POST /api/desktop/remote-machines`. Mints one
  `rendererEpoch` per panel; every command carries the actor; a snapshot whose actor does not carry
  this panel's epoch is dropped (a stale panel can never relabel a newer machine). Mutating
  commands keep their request id in a bounded retry map; `retry(requestId)` re-issues the exact
  envelope, `receipt(requestId)` settles a lost acknowledgement. Maps transport failures to the
  `network` code; refuses work after `dispose()`.
- `use-remote-machines.ts` — panel hook. Observational `read` poll (3000 ms relaxed / 1200 ms while
  a change is in flight or a recovery is open); never connects as an effect of viewing. Mutations
  are serialized with a renderer-epoch guard; `uncertain` answers become a pending retry that keeps
  the typed form input and the request identity; `stale`/`busy`/`authority_missing` surface
  truthfully. Exposes `pair/replace/select/remove/cancel/recover/retry/settle/healthRefresh` and
  `DESKTOP_REMOTE_MACHINE_LIMITS`.
- `remote-machines-client.test.ts` — envelopes (read/pair/replace/select/remove incl.
  `confirmation: 'Remove'` and `expectedRevision: 'unconfigured'`), refusal code surfacing, retry
  with the same request identity, dispose/network behavior.
- `use-remote-machines.test.tsx` — happy-dom render-prop probe with an echo-actor fetch mock: read
  on open, no fetch while inactive, pair on explicit connect, lost-ack retry identity, foreign-epoch
  drop, authority_missing unavailable, remove against exact revision, recovery.

`apps/ui/components/desktop/remote-machines/`
- `RemoteMachinesDialog.tsx` — the ServersDialog port: loading (`SkeletonList rows={2}`) → row or
  pairing; one health probe on open (then observational only); replace and remove go through
  ConfirmDialog gates; unavailable/authority-missing state with Refresh; exact original dialog
  classes and `REMOTE_MACHINE_COPY` strings.
- `RemoteMachineRow.tsx` — "This workspace's server" `PanelRow` with health badge/description
  mapping (`REMOTE_HEALTH_PRESENTATION`), Select ("Use this connection" when `!selected`),
  Replace, Remove, "Check again" when health !== connected, and the stalled-change recovery
  actions (Retry recovery / Cancel) when `openReceipt` is present.
- `RemoteMachinePairing.tsx` — add-server form: menu → manual (original labels, masked key, Connect
  disabled until both fields are filled) and the truthful pairing-token branch (hosted-only, no
  local port on the Mac — explains instead of pretending); lost-ack Retry / Check acknowledgement.
- `RemoteMachineRow.test.tsx` — badge/copy mapping for every canonical health state, select,
  check-again, remove, recovery, busy disable, commit-7 truncation.
- `RemoteMachinePairing.test.tsx` — menu→manual walk, Connect gating, trimmed payload, unsupported
  token branch, pending-retry actions, replace warning.
- `RemoteMachinesDialog.test.tsx` — loading→row, empty→pairing, pair envelope on connect, replace
  confirm gate (radix AlertDialog) posting the exact revision, remove confirm posting
  `confirmation: 'Remove'`, authority_missing unavailable state, one-shot health probe.

All regressions are authored but **not run** (no local test/typecheck/lint runs are allowed; the
worktree has no node_modules).

## Root wiring (activation fragments — root owns these files)

1. Contracts barrel — `packages/contracts/src/index.ts`: add
   `export * from './desktop-remote-machines.js'` (lane G) and the Round35
   `export * from './desktop-workspaces.js'` it imports.
2. Route — create `apps/ui/app/api/desktop/remote-machines/route.ts`:

   ```ts
   import { desktopRoute } from '@/lib/desktop/server/http'
   // lane G provides the server-side handler; root supplies the supervisor bridge.
   export const dynamic = 'force-dynamic'
   export async function POST(request: Request) {
       return desktopRoute(request, async runtime =>
           remoteMachinesHandler(runtime, request)) // G's apps/ui/lib/desktop/server/remote-machines/**
   }
   ```

   The client (this lane) posts G's `desktopRemoteCommandSchema` envelopes and parses
   `desktopRemoteResultSchema` answers; auth is the existing `desktopRoute` /
   `authenticateDesktopRequest` session-cookie flow. No upstream engine endpoint is used.
3. Mount — where the board/workspace menu renders desktop dialogs, add a "Servers" item
   (`ServerIcon`, copy "Servers" — the original WorkspaceSwitcher menu item) that opens:

   ```tsx
   <RemoteMachinesDialog open={serversOpen} onOpenChange={setServersOpen}
       actor={{ installId, workspaceId, launchNonce }} />
   ```

   The actor seed comes from the desktop runtime (`readDesktopRuntime`: installId/launchNonce/
   workspaceId, already available to root; Round35's catalog supplies workspace id). The client
   mints `rendererEpoch` per panel. Server-side state is G's lane: `apps/desktop/src/main/
   remote-machines/**` (native bridge) + G's server handler under
   `apps/ui/lib/desktop/server/remote-machines/**`, with the Round35 switch-phase contract.

## Supported / dependent / unsupported matrix

| Behavior | Status |
| --- | --- |
| Original Servers dialog layout, copy, row, badges, skeletons, ConfirmDialog remove | Supported |
| Pair (manual address+key) against `expectedRevision: 'unconfigured'` | Supported |
| Replace over an existing machine via confirmation gate, exact revision | Supported |
| Select ("Use this connection"), Remove (`confirmation: 'Remove'`) | Supported |
| Health probe on open + observational read poll; "Check again" | Supported |
| Lost-ack retry with same request identity; receipt settle | Supported |
| Recovery (Retry recovery / Cancel) for a stalled `openReceipt` | Supported |
| `auth_needed`, `identity_changed`, `unsupported`, `unreachable`, `cancelled` copy | Supported |
| Hosted pairing-token flow | Unsupported on Mac (no local port) — truthful copy, no fake flow |
| Live engine/network/restart/Keychain behavior | Dependent — root + G validate; unrun |
| Contracts barrel exports, route, mount | Dependent — root activation fragments above |
| Round35 switch phases / catalog identity | Dependent — root integration, not accepted yet |
| Tests, typecheck, lint, build, packaging | Unrun by this lane (regressions authored only) |

## Honest limitations

- No tests/typecheck/lint/build/server/install/network/Docker/browser/Keychain/restart runs were
  performed; the worktree has no node_modules. Regressions are authored but unverified.
- The contracts barrel does not yet export `desktop-remote-machines` (G's v1, uncommitted in G's
  worktree) or Round35 `desktop-workspaces`; the client/UI imports them from `@rerun/contracts`
  and will not typecheck until root adds both.
- The `/api/desktop/remote-machines` route and G's server handler are root's/G's to land; this lane
  ships only the client contract and the exact fragments above.
- Actor seed (`installId/workspaceId/launchNonce`) must come from root's mount fragment; the client
  mints the renderer epoch itself and drops any snapshot not carrying it.
- "Use this connection" / "Check again" / "Replace" are desktop additions beyond the original;
  original extras kept inline ("Add a server" SectionTitle, "Your coworkers run on a machine you
  own…", "Enter address and key", "Add server", "This workspace's server").
- No push, merge, deploy, or acceptance claims.
