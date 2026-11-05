import { brainUiWriteSchema, BRAIN_UI_VALUE_MAX_BYTES } from '@/lib/desktop/brain-ui-state-schema'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { BrainUiConflict, listBrainUiState, readBrainUiRecord, writeBrainUiState } from '@/lib/desktop/server/brain-ui-state/store'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const params = new URL(request.url).searchParams
        return Response.json(params.has('key') ? await readBrainUiRecord(db, params.get('key')!) : await listBrainUiState(db), { headers })
    })
}
export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new DesktopHttpError(415, 'Send the Brain draft as JSON.')
        const limit = BRAIN_UI_VALUE_MAX_BYTES * 2 + 4096
        if (Number(request.headers.get('content-length')) > limit || !request.body) throw new DesktopHttpError(413, 'This Brain draft is too large.')
        const reader = request.body.getReader(), chunks: Uint8Array[] = []
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        let size = 0
        try {
            for (;;) {
                signal.throwIfAborted()
                const part = await reader.read()
                signal.throwIfAborted()
                if (part.done) break
                size += part.value.byteLength
                if (size > limit) throw new DesktopHttpError(413, 'This Brain draft is too large.')
                chunks.push(part.value)
            }
            let json: unknown
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DesktopHttpError(400, 'Send a valid Brain draft.') }
            const input = brainUiWriteSchema.safeParse(json)
            if (!input.success) throw new DesktopHttpError(400, 'Send a valid Brain draft and its saved version.')
            try { return Response.json(await writeBrainUiState(await openDesktopDatabase(runtime.dataRoot), input.data), { headers }) }
            catch (error) { if (error instanceof BrainUiConflict) return Response.json({ error: error.message, record: error.record }, { status: 409, headers }); throw error }
        } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
    })
}
