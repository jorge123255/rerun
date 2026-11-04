import 'server-only'
import type { DesktopDataScope } from '../data-scope'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import { readDesktopDataPreference, writeDesktopDataPreference } from './data-preferences'
import { desktopRoute } from './http'

async function boundedBody(request: Request): Promise<unknown> {
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Invalid preferred view.')
    const chunks: Uint8Array[] = []
    let bytes = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            (async () => {
                while (true) {
                    const item = await reader.read()
                    if (item.done) return
                    bytes += item.value.byteLength
                    if (bytes > 2_048) throw new DesktopHttpError(413, 'Preferred view request is too large.')
                    chunks.push(item.value)
                }
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new DesktopHttpError(408, 'Preferred view request timed out.')) }, 5_000) }),
        ])
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw new DesktopHttpError(400, 'Invalid preferred view.') }
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}) }
}
export function desktopDataPreferenceRoute(request: Request, scope: DesktopDataScope) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (request.method === 'GET') {
            const viewId = await readDesktopDataPreference(db, scope, new URL(request.url).searchParams.get('table'))
            return Response.json({ viewId }, { headers: { 'Cache-Control': 'no-store' } })
        }
        if (request.method !== 'PUT') throw new DesktopHttpError(405, 'Method not allowed')
        const body = await boundedBody(request)
        request.signal.throwIfAborted()
        await writeDesktopDataPreference(db, scope, body)
        return Response.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } })
    })
}
