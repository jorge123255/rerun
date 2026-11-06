import 'server-only'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent } from '../store'
import { desktopResultFileDisposition, parseDesktopResultFileBody, type DesktopResultFileTicket } from './contract'

const noStore = { 'cache-control': 'no-store' }
const unavailable = 'This file is no longer available.'

export type DesktopResultFileRead = { bytes: Uint8Array; identity: string; size: number }
export type DesktopResultFileAuthority = {
    read(input: {
        runtime: DesktopRuntime
        agentId: string
        engineAgentId: string
        path: string
        scope: DesktopResultFileTicket['scope']
        identity: string
        size: number
        signal: AbortSignal
    }): Promise<DesktopResultFileRead | null>
}

let authority: DesktopResultFileAuthority | undefined

/** Root installs the only reader. Unbound stays closed. Passing undefined removes it. */
export function bindDesktopResultFileRead(next: DesktopResultFileAuthority | undefined): void {
    authority = next
}

export function desktopResultFileAuthority(): DesktopResultFileAuthority | undefined {
    return authority
}

export function unboundDesktopResultFileResponse(): Response {
    return Response.json({ error: 'Result file downloads are not available.', downloaded: false }, { status: 503, headers: noStore })
}

/** Bytes leave only when the read still matches the saved identity and size. A miss is not a download. */
export function desktopResultFileResponse(ticket: DesktopResultFileTicket, read: DesktopResultFileRead | null): Response {
    if (!read) return Response.json({ error: unavailable, downloaded: false }, { status: 404, headers: noStore })
    const same = read.identity === ticket.identity && read.size === ticket.size && read.bytes.byteLength === ticket.size
    if (!same) return Response.json({ error: 'This file changed and was not downloaded.', downloaded: false }, { status: 409, headers: noStore })
    const disposition = desktopResultFileDisposition(ticket.name)
    if (!disposition) return Response.json({ error: 'This file name cannot be downloaded.', downloaded: false }, { status: 400, headers: noStore })
    return new Response(new Uint8Array(read.bytes), {
        status: 200,
        headers: {
            ...noStore,
            'content-type': 'application/octet-stream',
            'content-length': String(read.bytes.byteLength),
            'content-disposition': disposition,
            'x-rerun-result-identity': ticket.identity,
        },
    })
}

/**
 * Read one saved result file for the coworker in the route. This does not start a model run or
 * publish a tool result. The engine agent id comes from the coworker row, never from the body.
 */
export async function handleDesktopResultFilePost(runtime: DesktopRuntime, agentId: string, request: Request): Promise<Response> {
    const bound = authority
    if (!bound) return unboundDesktopResultFileResponse()
    if (request.signal.aborted) return new Response(null, { status: 499, headers: noStore })
    let ticket: DesktopResultFileTicket | undefined
    try { ticket = parseDesktopResultFileBody(agentId, await request.json()) }
    catch { return Response.json({ error: 'Result file request was not understood.', downloaded: false }, { status: 400, headers: noStore }) }
    if (!ticket) return Response.json({ error: 'Result file request was not understood.', downloaded: false }, { status: 400, headers: noStore })
    const db = await openDesktopDatabase(runtime.dataRoot)
    const coworker = await findDesktopAgent(db, agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    await assertCoworkerNotDeleting(db, agentId)
    if (request.signal.aborted) return new Response(null, { status: 499, headers: noStore })
    try {
        const read = await bound.read({
            runtime, agentId, engineAgentId: coworker.engineAgentId, path: ticket.path, scope: ticket.scope,
            identity: ticket.identity, size: ticket.size, signal: request.signal,
        })
        if (request.signal.aborted) return new Response(null, { status: 499, headers: noStore })
        return desktopResultFileResponse(ticket, read)
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        if (request.signal.aborted) return new Response(null, { status: 499, headers: noStore })
        return Response.json({ error: unavailable, downloaded: false }, { status: 503, headers: noStore })
    }
}
