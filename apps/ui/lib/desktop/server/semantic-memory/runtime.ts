import 'server-only'
import { request } from '@/lib/engine/client'
import { desktopSemanticIndexStatusSchema, desktopSemanticRecallResultSchema } from '@rerun/contracts'
import { withCoworkerMemories } from '../memories'
import type { DesktopRuntime } from '../runtime'
import type { DesktopSemanticMemoryAuthority } from './authority'

export function desktopSemanticRuntimeAuthority(runtime: DesktopRuntime): DesktopSemanticMemoryAuthority {
    return {
        status: (id, signal) => withCoworkerMemories(runtime, id, (engine, owner) => request(engine, `/agents/${encodeURIComponent(owner)}/memories/semantic/status`, { method: 'GET', signal, cache: 'no-store' }, value => desktopSemanticIndexStatusSchema.parse(value))),
        recall: (id, input, signal) => withCoworkerMemories(runtime, id, (engine, owner) => request(engine, `/agents/${encodeURIComponent(owner)}/memories/semantic/recall`, { method: 'POST', body: JSON.stringify({ ...input, reinforce: 'none' }), signal, cache: 'no-store' }, value => desktopSemanticRecallResultSchema.parse(value))),
        maintain: (id, operation, signal) => withCoworkerMemories(runtime, id, (engine, owner) => request(engine, `/agents/${encodeURIComponent(owner)}/memories/semantic/index`, { method: 'POST', body: JSON.stringify({ operation }), signal, cache: 'no-store' }, value => desktopSemanticIndexStatusSchema.parse(value))),
    }
}
