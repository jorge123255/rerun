'use client'

import {
    desktopToolInstallSnapshotSchema,
    type DesktopToolInstallAction,
    type DesktopToolInstallDecision,
    type DesktopToolInstallInspect,
    type DesktopToolInstallSnapshot,
} from '@rerun/contracts'

function exactSource(before: DesktopToolInstallSnapshot, after: DesktopToolInstallSnapshot) {
    if (before.operationId !== after.operationId || before.agentId !== after.agentId || before.sessionId !== after.sessionId || before.runId !== after.runId || before.toolCallId !== after.toolCallId || before.proposalRevision !== after.proposalRevision || before.guestId !== after.guestId || JSON.stringify(before.packages.map(item => item.package)) !== JSON.stringify(after.packages.map(item => item.package))) throw new DesktopToolInstallClientError('Installation acknowledgement belonged to another proposal.')
    return after
}
const MAX_RESPONSE_BYTES = 1_000_000

export class DesktopToolInstallClientError extends Error {
    constructor(message: string, readonly snapshot?: DesktopToolInstallSnapshot) {
        super(message)
        this.name = 'DesktopToolInstallClientError'
    }
}

export async function readDesktopToolInstallBody(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Installation read cancelled')) }
                signal.addEventListener('abort', abort, { once: true })
                reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
                if (signal.aborted) abort()
            })
            if (item.done) break
            size += item.value.byteLength
            if (size > maxBytes) throw new Error('Tool installation response is too large.')
            chunks.push(item.value)
        }
    } finally { void reader.cancel().catch(() => undefined) }
    try {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
        throw new Error('Tool installation response was malformed.')
    }
}

function messageOf(body: unknown, fallback: string): string {
    return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : fallback
}

export function createDesktopToolInstallClient(sessionId: string) {
    const url = `/api/desktop/sessions/${encodeURIComponent(sessionId)}/tool-install`
    const controllers = new Set<AbortController>()
    const decisionRequests = new Map<string, string>()
    const inspectRequests = new Map<string, string>()
    let closed = false

    async function request(input: DesktopToolInstallAction, signal?: AbortSignal, expected?: DesktopToolInstallSnapshot): Promise<DesktopToolInstallSnapshot> {
        if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const active = AbortSignal.any([controller.signal, AbortSignal.timeout(305_000), ...(signal ? [signal] : [])])
            const response = await fetch(url, {
                method: 'POST', cache: 'no-store', signal: active,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
            })
            const body = await readDesktopToolInstallBody(response, active)
            active.throwIfAborted()
            if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
            const snapshot = body && typeof body === 'object' && 'installation' in body ? desktopToolInstallSnapshotSchema.safeParse(body.installation) : null
            if (snapshot?.success && (snapshot.data.sessionId !== sessionId || snapshot.data.operationId !== input.operationId)) throw new DesktopToolInstallClientError('Installation response belonged to another conversation.')
            if (snapshot?.success && expected) exactSource(expected, snapshot.data)
            if (!response.ok) throw new DesktopToolInstallClientError(messageOf(body, 'Tool installation failed.'), snapshot?.success ? snapshot.data : undefined)
            if (!snapshot?.success) throw new DesktopToolInstallClientError('Tool installation acknowledgement was malformed.')
            return snapshot.data
        } catch (error) {
            if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
            throw error
        } finally { controllers.delete(controller) }
    }

    return {
        async read(operationId: string, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot | null> {
            if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
            const controller = new AbortController()
            controllers.add(controller)
            try {
                const active = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
                const response = await fetch(`${url}?operationId=${encodeURIComponent(operationId)}`, { cache: 'no-store', signal: active })
                const body = await readDesktopToolInstallBody(response, active)
                active.throwIfAborted()
                if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
                if (!response.ok) throw new DesktopToolInstallClientError(messageOf(body, 'Could not read tool installation.'))
                const snapshot = body && typeof body === 'object' && 'installation' in body && body.installation !== null ? desktopToolInstallSnapshotSchema.safeParse(body.installation) : null
                if (snapshot && !snapshot.success) throw new DesktopToolInstallClientError('Tool installation response was malformed.')
                if (snapshot?.success && (snapshot.data.sessionId !== sessionId || snapshot.data.operationId !== operationId)) throw new DesktopToolInstallClientError('Installation response belonged to another conversation.')
                return snapshot?.success ? snapshot.data : null
            } finally { controllers.delete(controller) }
        },

        decide(snapshot: DesktopToolInstallSnapshot, decision: DesktopToolInstallDecision['decision'], note?: string, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            const key = JSON.stringify([snapshot.operationId, snapshot.revision, decision, note ?? ''])
            let requestId = decisionRequests.get(key)
            if (!requestId) {
                requestId = crypto.randomUUID()
                decisionRequests.set(key, requestId)
            }
            return request({ operation: 'decide', requestId, operationId: snapshot.operationId, expectedRevision: snapshot.revision, decision, ...(note ? { note } : {}) }, signal, snapshot).then(result => exactSource(snapshot, result))
        },

        inspect(snapshot: DesktopToolInstallSnapshot, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            const key = JSON.stringify([snapshot.operationId, snapshot.revision])
            let requestId = inspectRequests.get(key)
            if (!requestId) {
                requestId = crypto.randomUUID()
                inspectRequests.set(key, requestId)
            }
            return request({ operation: 'inspect', requestId, operationId: snapshot.operationId, expectedRevision: snapshot.revision }, signal, snapshot).then(result => exactSource(snapshot, result))
        },

        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
            decisionRequests.clear()
            inspectRequests.clear()
        },
    }
}

export type DesktopToolInstallClient = ReturnType<typeof createDesktopToolInstallClient>
