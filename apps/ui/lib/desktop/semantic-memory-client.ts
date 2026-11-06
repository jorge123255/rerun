'use client'

import {
    desktopSemanticIndexStatusSchema,
    desktopSemanticRecallResultSchema,
    type DesktopSemanticIndexStatus,
    type DesktopSemanticRecallResult,
} from '@rerun/contracts'

export class DesktopSemanticMemoryClientError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DesktopSemanticMemoryClientError'
    }
}

export function createDesktopSemanticMemoryClient(ownerId: string) {
    let disposed = false
    let controller: AbortController | null = null
    const base = `/api/desktop/coworkers/${encodeURIComponent(ownerId)}/semantic-memory`

    async function send(path: string, body: Record<string, unknown> | undefined): Promise<unknown> {
        if (disposed) throw new DesktopSemanticMemoryClientError('Semantic recall was cancelled.')
        controller?.abort()
        const current = new AbortController()
        controller = current
        let response: Response
        try {
            response = await fetch(path, {
                method: 'POST',
                cache: 'no-store',
                signal: current.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            })
        } catch (error) {
            if (disposed || current.signal.aborted) throw new DesktopSemanticMemoryClientError('Semantic recall was cancelled.')
            throw error
        }
        if (disposed || current.signal.aborted) throw new DesktopSemanticMemoryClientError('Semantic recall was cancelled.')
        const data = await response.json().catch(() => null)
        if (disposed || current.signal.aborted) throw new DesktopSemanticMemoryClientError('Semantic recall was cancelled.')
        if (!response.ok) {
            const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
                ? data.error
                : 'Could not search memories. Try again.'
            throw new DesktopSemanticMemoryClientError(message)
        }
        return data
    }

    return {
        dispose() {
            disposed = true
            controller?.abort()
        },
        // Panel recall. The body has no reinforce field, so a search cannot strengthen notes.
        async recall(query: string, includeDormant = false): Promise<DesktopSemanticRecallResult> {
            const data = await send(base, { query, limit: 5, includeDormant })
            const parsed = desktopSemanticRecallResultSchema.safeParse(data)
            if (!parsed.success) throw new DesktopSemanticMemoryClientError('Semantic recall returned an invalid result.')
            return parsed.data
        },
        async retryIndex(): Promise<DesktopSemanticIndexStatus> {
            const data = await send(`${base}/index`, { operation: 'retry' })
            const parsed = desktopSemanticIndexStatusSchema.safeParse(data)
            if (!parsed.success) throw new DesktopSemanticMemoryClientError('Semantic index status was invalid.')
            return parsed.data
        },
    }
}
