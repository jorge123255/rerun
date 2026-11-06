import type { ComputerLaunchOutcome, ComputerPanelOwner, ComputerPanelPorts } from './contract'
import { MissingComputerPanelAuthority } from './contract'
import { ownerKey } from './controller'

export type LaunchAttempt =
    | { phase: 'pending'; requestId: string; app: 'terminal' | 'files' }
    | { phase: 'acknowledged'; requestId: string; app: 'terminal' | 'files'; outcome: ComputerLaunchOutcome & { status: 'opened' | 'focused' } }
    | { phase: 'failed'; requestId: string; app: 'terminal' | 'files'; reason: string }
    /** Lost ACK: the guest may have opened it. Retry keeps the SAME requestId (launcher reconciles, never respawns). */
    | { phase: 'uncertain'; requestId: string; app: 'terminal' | 'files'; reason: string }

const UNCERTAIN = 'We could not confirm whether the app opened. Try again to check; it will not open twice.'

/**
 * One launcher per exact owner. Duplicate clicks while pending are dropped; an uncertain attempt
 * blocks other launches and retries with its identity; owner change or dispose drops late replies.
 */
export function createComputerLauncher(owner: ComputerPanelOwner, ports: Pick<ComputerPanelPorts, 'launchApp' | 'revalidateOwner'>, onChange: (a: LaunchAttempt | null) => void, newId: () => string = () => crypto.randomUUID()) {
    let attempt: LaunchAttempt | null = null
    let controller: AbortController | undefined
    let disposed = false
    const key = ownerKey(owner)
    const set = (next: LaunchAttempt | null) => { if (!disposed) { attempt = next; onChange(next) } }
    return {
        get attempt() { return attempt },
        restore(saved: { requestId: string; app: 'terminal' | 'files' }) { if (!attempt || attempt.phase === 'failed') set({ phase: 'uncertain', ...saved, reason: UNCERTAIN }) },
        get ownerKey() { return key },
        async launch(app: 'terminal' | 'files'): Promise<void> {
            if (disposed || attempt?.phase === 'pending') return
            if (attempt?.phase === 'uncertain' && attempt.app !== app) return
            const requestId = attempt?.phase === 'uncertain' ? attempt.requestId : newId()
            const own = new AbortController(); controller = own
            set({ phase: 'pending', requestId, app })
            const live = () => !disposed && controller === own
            try {
                if (!(await ports.revalidateOwner(owner, own.signal))) { if (live()) set({ phase: 'failed', requestId, app, reason: 'This coworker’s active screen run has changed.' }); return }
                if (!live()) return
                const outcome = await ports.launchApp(owner, app, requestId, own.signal)
                if (!live()) return
                if (outcome.status === 'opened' || outcome.status === 'focused') set({ phase: 'acknowledged', requestId, app, outcome })
                else if (outcome.status === 'interrupted') set({ phase: 'uncertain', requestId, app, reason: outcome.reason })
                else if ('reason' in outcome) set({ phase: 'failed', requestId, app, reason: outcome.reason })
                else set({ phase: 'uncertain', requestId, app, reason: UNCERTAIN })
            } catch (error) {
                if (!live()) return
                if (error instanceof MissingComputerPanelAuthority) set({ phase: 'failed', requestId, app, reason: 'Opening this app from the panel is not available yet on this Mac.' })
                else set({ phase: 'uncertain', requestId, app, reason: UNCERTAIN })
            }
        },
        dismiss() { if (attempt && attempt.phase !== 'pending' && attempt.phase !== 'uncertain') set(null) },
        dispose() { disposed = true; controller?.abort() },
    }
}
