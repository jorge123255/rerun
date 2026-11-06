'use client'

import {
    desktopToolInstallSnapshotSchema,
    type DesktopToolInstallAction,
    type DesktopToolInstallDecision,
    type DesktopToolInstallInspect,
    type DesktopToolInstallSnapshot,
} from '@rerun/contracts'

const MAX_RESPONSE_BYTES = 1_000_000

export class DesktopToolInstallClientError extends Error {
    constructor(message: string, readonly snapshot?: DesktopToolInstallSnapshot) {
        super(message)
        this.name = 'DesktopToolInstallClientError'
    }
}

async function bodyOf(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw new Error('Tool installation response is too large.')
            chunks.push(item.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
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

    async function request(input: DesktopToolInstallAction, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
        if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const active = AbortSignal.any([controller.signal, AbortSignal.timeout(305_000), ...(signal ? [signal] : [])])
            const response = await fetch(url, {
                method: 'POST', cache: 'no-store', signal: active,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
            })
            const body = await bodyOf(response, active)
            active.throwIfAborted()
            if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
            const snapshot = body && typeof body === 'object' && 'installation' in body ? desktopToolInstallSnapshotSchema.safeParse(body.installation) : null
            if (snapshot?.success && snapshot.data.sessionId !== sessionId) throw new DesktopToolInstallClientError('Installation response belonged to another conversation.')
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
                const body = await bodyOf(response, active)
                active.throwIfAborted()
                if (closed) throw new DesktopToolInstallClientError('Tool installation owner changed')
                if (!response.ok) throw new DesktopToolInstallClientError(messageOf(body, 'Could not read tool installation.'))
                const snapshot = body && typeof body === 'object' && 'installation' in body && body.installation !== null ? desktopToolInstallSnapshotSchema.safeParse(body.installation) : null
                if (snapshot && !snapshot.success) throw new DesktopToolInstallClientError('Tool installation response was malformed.')
                if (snapshot?.success && snapshot.data.sessionId !== sessionId) throw new DesktopToolInstallClientError('Installation response belonged to another conversation.')
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
            return request({ operation: 'decide', requestId, operationId: snapshot.operationId, expectedRevision: snapshot.revision, decision, ...(note ? { note } : {}) }, signal)
        },

        inspect(snapshot: DesktopToolInstallSnapshot, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            const key = JSON.stringify([snapshot.operationId, snapshot.revision])
            let requestId = inspectRequests.get(key)
            if (!requestId) {
                requestId = crypto.randomUUID()
                inspectRequests.set(key, requestId)
            }
            return request({ operation: 'inspect', requestId, operationId: snapshot.operationId, expectedRevision: snapshot.revision }, signal)
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
