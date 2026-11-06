import { basename } from 'node:path'
import { readDesktopPackageBytes } from './templates.mjs'

/** The renderer receives an opaque verified snapshot ID, never a path, key or file bytes. */
export function createDesktopCoworkerShareFiles({ dialog,context,fetch: request = fetch }) {
    let busy = false
    return { async pickImport() {
        if (busy) throw new Error('Finish the open coworker file dialog first.')
        busy = true
        try {
            const initial = context()
            const check = () => {
                const now = context()
                if (!initial?.runtime || now?.runtime !== initial.runtime || now.window !== initial.window) throw new Error('The workspace changed. Choose the coworker file again.')
            }
            check()
            const app = new URL(initial.runtime.app.origin)
            if (app.protocol !== 'http:' || app.hostname !== '127.0.0.1' || !app.port || app.username || app.password || app.pathname !== '/') throw new Error('The local coworker service is unavailable.')
            const picked = await dialog.showOpenDialog(initial.window,{ title: 'Import coworker',properties: ['openFile'],filters: [{ name: 'Rerun coworker archive',extensions: ['gz'] }] })
            check()
            if (picked.canceled) return null
            if (picked.filePaths.length !== 1) throw new Error('Choose one coworker archive.')
            const path = picked.filePaths[0],fileName = basename(path)
            if (!/\.tar\.gz$/i.test(fileName) || fileName.length > 180 || /[\\/\p{Cc}]/u.test(fileName)) throw new Error('Choose a Rerun .tar.gz coworker archive.')
            const bytes = await readDesktopPackageBytes(path,check)
            check()
            const signal = AbortSignal.timeout(120_000)
            const response = await request(new URL('/api/desktop/internal/coworker-share/ingest',app),{
                method: 'POST',redirect: 'error',signal,headers: { Authorization: `Bearer ${initial.runtime.engine.apiKey}`,'Content-Type': 'application/gzip' },body: bytes,
            })
            check()
            const length = response.headers.get('content-length')
            if (length && (!/^\d+$/.test(length) || Number(length) > 4096)) throw new Error('The coworker import receipt is invalid.')
            const reader = response.body?.getReader()
            if (!reader) throw new Error('The coworker import receipt is unavailable.')
            const chunks = []; let total = 0
            try {
                for (;;) {
                    check();signal.throwIfAborted()
                    const part = await reader.read()
                    check();signal.throwIfAborted()
                    if (part.done) break
                    total += part.value.length
                    if (total > 4096) throw new Error('The coworker import receipt is invalid.')
                    chunks.push(Buffer.from(part.value))
                }
            } finally { await reader.cancel().catch(() => {});reader.releaseLock() }
            const result = JSON.parse(Buffer.concat(chunks,total).toString('utf8'))
            if (!response.ok || !/^[a-f0-9]{32}$/.test(result.snapshotId)) throw new Error('The selected coworker archive could not be verified.')
            return { snapshotId: result.snapshotId,fileName }
        } finally { busy = false }
    } }
}
