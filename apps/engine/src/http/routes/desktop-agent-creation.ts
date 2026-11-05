import { Hono } from 'hono'
import { createDesktopAgent, desktopAgentCreationSchema } from '../../desktop/agent-creation.js'
import { desktopApp } from '../../desktop/policy.js'
import { HttpError, notFound } from '../../lib/errors.js'

const BODY_BYTES = 32 * 1024
const BODY_DEADLINE_MS = 6000

async function bodyOf(request: Request): Promise<unknown> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_BYTES)) throw new HttpError(413, 'Coworker creation request is too large.')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected a JSON coworker creation request.')
    if (!request.body) throw new HttpError(400, 'Expected a coworker creation request.')
    const reader = request.body.getReader()
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
    const cancel = (error: Error) => { void reader.cancel().catch(() => {}); rejectCancelled(error) }
    const abort = () => cancel(new HttpError(408, 'Coworker creation request was cancelled.'))
    const timer = setTimeout(() => cancel(new HttpError(408, 'Coworker creation request timed out.')), BODY_DEADLINE_MS)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const work = (async () => {
        try {
            let bytes = 0
            let text = ''
            const decoder = new TextDecoder('utf-8', { fatal: true })
            while (!request.signal.aborted) {
                const chunk = await reader.read()
                if (chunk.done) {
                    try { return JSON.parse(text + decoder.decode()) as unknown }
                    catch { throw new HttpError(400, 'Invalid coworker creation request.') }
                }
                bytes += chunk.value.byteLength
                if (bytes > BODY_BYTES) throw new HttpError(413, 'Coworker creation request is too large.')
                try { text += decoder.decode(chunk.value, { stream: true }) }
                catch { throw new HttpError(400, 'Invalid coworker creation request.') }
            }
            throw new HttpError(408, 'Coworker creation request was cancelled.')
        } catch (error) { void reader.cancel().catch(() => {}); throw error }
        finally { reader.releaseLock() }
    })()
    try { return await Promise.race([work, cancelled]) }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort) }
}

export const desktopAgentCreationRoutes = new Hono()
desktopAgentCreationRoutes.post('/create', async c => {
    if (!desktopApp()) throw notFound('desktop creation')
    const input = desktopAgentCreationSchema.parse(await bodyOf(c.req.raw))
    if (c.req.raw.signal.aborted) throw new HttpError(408, 'Coworker creation request was cancelled.')
    // Once admitted, finishing publication is intentional even if the response is lost. The
    // caller retries this requestId; it never retries the random-ID hosted factory.
    return c.json(await createDesktopAgent(input), 201)
})
