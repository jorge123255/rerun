import 'server-only'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'
type State = { sequence: number; action: 'freeze' | 'unfreeze' | null; frozen: boolean }
const KEY = Symbol.for('rerun.desktop.workspace.freeze.v2')
const states = () => ((globalThis as unknown as Record<symbol, Map<string, State>>)[KEY] ??= new Map<string, State>())
const key = (runtime: DesktopRuntime) => JSON.stringify([runtime.dataRoot, runtime.launchNonce])
function state(runtime: DesktopRuntime) {
    const entries = states(), id = key(runtime)
    let current = entries.get(id)
    if (!current) { current = { sequence: 0, action: null, frozen: process.env.RERUN_DESKTOP_ADMISSIONS_FROZEN === '1' }; entries.set(id, current) }
    return current
}
export function setDesktopWorkspaceFrozen(runtime: DesktopRuntime, frozen: boolean) { state(runtime).frozen = frozen }
export function beginDesktopWorkspaceAdmission(runtime: DesktopRuntime, action: 'freeze' | 'unfreeze', sequence: number) {
    const current = state(runtime)
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence < current.sequence || sequence === current.sequence && current.action !== action) throw new DesktopHttpError(409, 'Workspace admission request is stale')
    current.sequence = sequence; current.action = action
    if (action === 'freeze') current.frozen = true
}
export function completeDesktopWorkspaceAdmission(runtime: DesktopRuntime, action: 'freeze' | 'unfreeze', sequence: number) {
    const current = state(runtime)
    if (current.sequence !== sequence || current.action !== action) throw new DesktopHttpError(409, 'Workspace admission request was superseded')
    current.frozen = action === 'freeze'
}
export function assertDesktopWorkspaceAdmission(runtime: DesktopRuntime) {
    if (state(runtime).frozen) throw new DesktopHttpError(409, 'This workspace is switching. Wait for it to finish.')
}
export function desktopWorkspaceFrozen(runtime: DesktopRuntime) { return state(runtime).frozen }
