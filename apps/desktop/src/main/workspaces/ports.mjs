/**
 * Typed supervisor / app ports for the local workspace transition.
 * A named port is not a completed production capability until root binds it.
 *
 * Concrete adapter status is documented on each field below and in the handoff matrix.
 */

/**
 * @typedef {object} DesktopWorkspaceSupervisorPorts
 * @property {() => { state: string, message?: string }} readStatus
 *   Bound today: RuntimeSupervisor.status / publicStatus.
 * @property {() => ({ workspaceId: number, launchNonce: string, dataRoot: string } | null)} readRuntimeIdentity
 *   Bound today: RuntimeSupervisor.runtime snapshot (workspaceId currently hard-coded to 1 in root).
 * @property {(workspaceId: number) => Promise<{ engineRoot: string, workspaceId: number }>} bindAndStart
 *   MISSING root authority W1-A1: start services for an arbitrary workspace id (today only id 1).
 * @property {() => Promise<void>} stopAndDrain
 *   Partially bound: RuntimeSupervisor.stop() drains MCP tools then children. Must confirm cleanup.
 * @property {() => Promise<boolean>} freezeAdmissions
 *   MISSING root authority W1-A2: refuse new runs/webhooks/schedule fires during a switch.
 * @property {() => Promise<void>} unfreezeAdmissions
 *   MISSING root authority W1-A2 companion.
 * @property {() => Promise<{ saved: boolean }>} flushDrafts
 *   Partially bound: BeforeQuitDrafts.request protocol can be reused for switch flush.
 * @property {(workspaceId: number) => Promise<boolean>} verifyRuntimeIdentity
 *   MISSING root authority W1-A3: health payload must report the requested workspaceId (today literal 1).
 * @property {() => boolean} isQuitInProgress
 *   Bound today: quitting flag in index.mjs once root wires the coordinator.
 */

export const DESKTOP_WORKSPACE_AUTHORITIES = Object.freeze({
    'W1-A1': 'Supervisor bindAndStart(workspaceId) for ids other than 1 (runtime.mjs bindWorkspace + health workspaceId).',
    'W1-A2': 'Admission freeze/unfreeze across chat runs, webhooks, schedules and Foreman during a switch.',
    'W1-A3': 'Runtime/health identity reports the active workspaceId (replace z.literal(1) / workspaceId === 1 checks).',
    'W1-A4': 'IPC handlers desktop:workspaces-* + preload bridge (root-owned index.mjs / preload.cjs).',
    'W1-A5': 'Per-workspace app.db open for id>1 (or lift desktop_workspace CHECK id=1 and scope every query).',
    'W1-A6': 'Cold-launch selection: launch() reads selected.json and starts that workspace before first paint.',
})

export function missingAuthority(code) {
    const error = new Error(`Missing root authority: ${code}`)
    error.code = 'authority_missing'
    error.authority = code
    return error
}
