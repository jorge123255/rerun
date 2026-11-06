import 'server-only'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'

const slot = Symbol.for('rerun.desktop.secret-authority.v1')
type State = { generation: number; pending: number }
const states = () => ((globalThis as unknown as Record<symbol, Map<string, State>>)[slot] ??= new Map())
const key = (runtime: DesktopRuntime, kind: 'owner' | 'session', id: string) => JSON.stringify([runtime.dataRoot, runtime.launchNonce, kind, id])
const state = (key: string) => { const all = states(); let value = all.get(key); if (!value) { value = { generation: 0, pending: 0 }; all.set(key, value) }; return value }

export function watchDesktopSecretAuthority(runtime: DesktopRuntime, agentId: string, sessionId: string): () => void {
    const snapshots = [state(key(runtime, 'owner', agentId)), state(key(runtime, 'session', sessionId))].map(value => ({ value, generation: value.generation }))
    return () => { if (snapshots.some(({ value, generation }) => value.pending || value.generation !== generation)) throw new DesktopHttpError(409, 'The credential request was stopped or its coworker changed. Reload the conversation.') }
}

async function transition<T>(runtime: DesktopRuntime, kind: 'owner' | 'session', id: string, work: () => Promise<T>): Promise<T> {
    const current = state(key(runtime, kind, id))
    current.pending++; current.generation++
    try { return await work() } finally { current.pending--; current.generation++ }
}
export const withDesktopSecretOwnerTransition = <T>(runtime: DesktopRuntime, agentId: string, work: () => Promise<T>) => transition(runtime, 'owner', agentId, work)
export const withDesktopSecretSessionTransition = <T>(runtime: DesktopRuntime, sessionId: string, work: () => Promise<T>) => transition(runtime, 'session', sessionId, work)
