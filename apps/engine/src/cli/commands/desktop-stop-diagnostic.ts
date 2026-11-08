import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const components = [
    'http-listener', 'schedule-admission', 'trigger-runtime', 'delegation', 'custom-providers',
    'mcp-callback', 'skill-proposals', 'screen-viewer', 'isolated-screens',
    'semantic-memory', 'schedule-tools', 'tool-install', 'foreman',
    'computer-panel', 'guest-shell', 'claude-workers', 'run-abort-initial',
    'scheduler-preparation', 'run-abort-final', 'mcp-pool', 'native-workers', 'external-mcp',
] as const
type Component = typeof components[number]
type ComponentStatus = 'not-started' | 'pending' | 'fulfilled' | 'rejected'

/** One bounded private snapshot, never exception text, output, paths, or credentials.
 * Recording is best effort and does not turn an uncertain drain into success. */
export function createDesktopStopDiagnostic(engineRoot: string, identity: { launchNonce: string; workspaceId: number }) {
    const state = new Map<Component, ComponentStatus>(components.map(component => [component, 'not-started']))
    let status: 'stopping' | 'stopped' | 'failed' = 'stopping'
    let writing = Promise.resolve()
    const record = () => {
        const body = JSON.stringify({ launchNonce: identity.launchNonce, workspaceId: identity.workspaceId, status,
            components: components.map(component => ({ component, status: state.get(component)! })),
        }) + '\n'
        writing = writing.catch(() => {}).then(async () => {
            const temporary = join(engineRoot, `.desktop-stop-diagnostic-${randomUUID()}.tmp`)
            try {
                // Fresh exclusive file + atomic replacement preserves 0600 even when an
                // older diagnostic exists. The assigned engine root was already verified.
                await writeFile(temporary, body, { flag: 'wx', mode: 0o600 })
                await rename(temporary, join(engineRoot, 'desktop-stop-diagnostic.json'))
            } catch {
                // A full/unavailable disk must not change process-custody decisions.
            } finally { try { await rm(temporary, { force: true }) } catch {} }
        })
    }
    record()
    return {
        track<T>(component: Component, work: () => T | Promise<T>): Promise<T> {
            state.set(component, 'pending'); record()
            let result: T | Promise<T>
            // Invoke immediately: close methods synchronously revoke admission before
            // their first await, and diagnostics must not postpone that boundary.
            try { result = work() }
            catch (error) { state.set(component, 'rejected'); record(); return Promise.reject(error) }
            return Promise.resolve(result).then(value => {
                state.set(component, 'fulfilled'); record(); return value
            }, error => {
                state.set(component, 'rejected'); record(); throw error
            })
        },
        async finish(failed: boolean) { status = failed ? 'failed' : 'stopped'; record(); await writing },
        async flush() { await writing },
    }
}
