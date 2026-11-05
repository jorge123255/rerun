import { desktopRerunGrantsOf } from '@rerun/contracts'
import { z } from 'zod'
import { getAgent } from '../agents/registry.js'
import { listAgentIdsOnDisk } from '../agents/loader.js'
import { dataDir } from '../config/paths.js'
import { getSystemDb } from '../db/systemDb.js'
import { configureDesktopSchedules } from '../runtime/scheduler.js'
import { desktopScheduleOccurrenceSchema, recoverDesktopScheduleClaims } from '../runtime/desktop-schedule-state.js'
import { beginDesktopAgentWork, desktopDeletionPending } from './agent-lifecycle.js'

const initialized = new Map<string, Promise<void>>()

/** Once per immutable owner and engine lifetime, never during an already active occurrence. */
export function initializeDesktopScheduleOwner(agentId: string): Promise<void> {
    const key = `${dataDir()}\0${agentId}`
    const existing = initialized.get(key)
    if (existing) return existing
    const opening = (async () => {
        const release = beginDesktopAgentWork(agentId)
        try {
            await getAgent(agentId)
            const { client } = await getSystemDb(agentId)
            await client.executeMultiple(desktopScheduleOccurrenceSchema)
            await recoverDesktopScheduleClaims(agentId)
        } finally { release() }
    })().catch(error => { initialized.delete(key); throw error })
    initialized.set(key, opening)
    return opening
}

type Runtime = { app: { origin: string }; engine: { apiKey: string } }
const ack = z.object({ ok: z.literal(true), persisted: z.literal(true) })
const TIMEOUT_MS = 5_000
const MAX_ACK_BYTES = 4_096

function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Scheduled task request cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}

/** The same authenticated callback origin as engine notifications; redirects are never followed. */
async function callback(runtime: Runtime, body: unknown, signal?: AbortSignal): Promise<void> {
    const stop = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])])
    const response = await withSignal(fetch(`${runtime.app.origin}/api/webhooks/engine`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: stop,
    }), stop)
    if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('Scheduled task authorization unavailable') }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            stop.throwIfAborted()
            const item = await withSignal(reader.read(), stop)
            stop.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > MAX_ACK_BYTES) throw new Error('Invalid scheduled task acknowledgement')
            chunks.push(item.value)
        }
        ack.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally { void reader.cancel().catch(() => {}) }
}

let current: { authorize: (agentId: string) => Promise<void> } | undefined
export async function authorizeDesktopSchedule(agentId: string): Promise<void> {
    if (!current) throw new Error('Desktop schedules are unavailable')
    await current.authorize(agentId)
}

/** Configure fully before startScheduler; caller has already reconciled interrupted engine runs. */
export async function bindDesktopSchedules(runtime: Runtime) {
    let closed = false
    const stop = new AbortController()
    const active = () => { if (closed) throw new Error('Desktop schedules are stopping') }
    const authorize = async (agentId: string) => {
        active()
        const release = beginDesktopAgentWork(agentId)
        try {
            await initializeDesktopScheduleOwner(agentId); active()
            const agent = await getAgent(agentId); active()
            if (agent.id !== agentId || !agent.config.enabled || !desktopRerunGrantsOf(agent.config.tools).schedule) throw new Error('Scheduled tasks are disabled for this coworker')
            await callback(runtime, { event: 'desktop.schedule.authorize', agentId }, stop.signal)
            active()
            const latest = await getAgent(agentId)
            if (latest.id !== agentId || !latest.config.enabled || !desktopRerunGrantsOf(latest.config.tools).schedule) throw new Error('Scheduled tasks are disabled for this coworker')
            active()
        } finally { release() }
    }
    // No callback/network before the server listens: existing and newly created DBs are local.
    // A deletion interrupted by the previous app shutdown is recovered by the local UI; do
    // not let its marker prevent unrelated coworkers or the app from starting.
    for (const id of await listAgentIdsOnDisk()) if (!desktopDeletionPending(id)) await initializeDesktopScheduleOwner(id)
    const hooks = {
        authorize,
        adopt: async (agentId: string, sessionId: string, runId: string | null, title: string) => {
            await authorize(agentId)
            await callback(runtime, { event: 'desktop.schedule.adopt', agentId, sessionId, runId, title: title.slice(0, 160) }, stop.signal)
            await authorize(agentId)
        },
    }
    current = hooks
    configureDesktopSchedules(hooks)
    return {
        authorize,
        /** Close synchronously, then best-effort acknowledge terminal UI admission closure. */
        close: async () => {
            if (closed) return
            closed = true; stop.abort()
            await callback(runtime, { event: 'desktop.schedule.shutdown' })
        },
    }
}
