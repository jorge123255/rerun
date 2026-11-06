import { fxCameraSnapshotSchema, fxCameraResultSchema, fxCameraWriteSchema, type FxCameraPersistence } from './board-camera'

export function createFxCameraHttpPersistence(route: (workspaceId: number) => string): FxCameraPersistence {
    async function request(workspaceId: number, signal: AbortSignal, input?: unknown): Promise<unknown> {
        const url = new URL(route(workspaceId), window.location.origin)
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/desktop/') || url.search || url.hash || url.username || url.password) throw Error('Board view storage is unavailable.')
        const response = await fetch(url.pathname, { method: input === undefined ? 'GET' : 'PUT', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            credentials: 'same-origin', redirect: 'error', cache: 'no-store', ...(input !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) })
        if (!response.ok || !response.body) throw Error('Could not confirm the board view request.')
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0, text = ''
        try {
            for (;;) {
                const part = await reader.read(); signal.throwIfAborted()
                if (part.done) break
                bytes += part.value.byteLength
                if (bytes > 8192) throw Error('The saved board view is too large.')
                text += decoder.decode(part.value, { stream: true })
            }
            return JSON.parse(text + decoder.decode())
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    return {
        async read(workspaceId, signal) {
            const result = fxCameraSnapshotSchema.parse(await request(workspaceId, signal))
            if (result.workspaceId !== workspaceId) throw Error('Workspace changed.')
            return result
        },
        async write(input, signal) {
            const result = fxCameraResultSchema.parse(await request(input.workspaceId, signal, fxCameraWriteSchema.parse(input)))
            if (result.snapshot.workspaceId !== input.workspaceId || result.status === 'saved' && result.requestId !== input.requestId) throw Error('The board view acknowledgement changed.')
            return result
        },
    }
}
