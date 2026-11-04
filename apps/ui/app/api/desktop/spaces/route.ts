import { desktopSpaceWriteSchema } from '@/lib/desktop/spaces'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopBoardState, writeDesktopBoardState } from '@/lib/desktop/server/spaces'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }
const MAX_BODY_BYTES = 4096

async function readInput(request: Request) {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        throw new DesktopHttpError(415, 'Send this Box change as JSON.')
    const tooLarge = () => new DesktopHttpError(413, 'This Box change is too large.')
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
        await request.body?.cancel().catch(() => {})
        throw tooLarge()
    }
    if (!request.body) throw new DesktopHttpError(400, 'Choose a valid Box change.')
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            size += chunk.value.byteLength
            if (size > MAX_BODY_BYTES) {
                await reader.cancel().catch(() => {})
                throw tooLarge()
            }
            chunks.push(chunk.value)
        }
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(400, 'Could not read this Box change.')
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    catch { throw new DesktopHttpError(400, 'Choose a valid Box change.') }
}

export function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json({ board: await readDesktopBoardState(await openDesktopDatabase(runtime.dataRoot)) }, { headers }))
}

export function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopSpaceWriteSchema.safeParse(await readInput(request))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid Box change.')
        const board = await writeDesktopBoardState(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        return Response.json({ board }, { headers })
    })
}
