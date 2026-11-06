// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopServiceAccountsClient } from './service-accounts-client'

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })
function respond(payload: unknown, status = 200) { return Response.json(payload, { status }) }
function server() {
    const journal = new Map<string, { requestId: string; acknowledged: boolean }>()
    const completed = new Set<string>(), mutations: Array<{ owner: string; body: Record<string, unknown> }> = []
    let loseReply = false, loseAck = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const owner = String(url).split('/coworkers/')[1].split('/')[0]
        const mutation = body.action === 'prepare-attempt' || body.action === 'acknowledge-attempt' ? body.mutation as Record<string, unknown> : body
        const { requestId, ...payload } = mutation
        const key = JSON.stringify([owner, payload])
        if (body.action === 'prepare-attempt') {
            let row = journal.get(key)
            if (!row || row.acknowledged && row.requestId === body.afterRequestId) { row = { requestId: String(requestId), acknowledged: false }; journal.set(key, row) }
            return respond({ requestId: row.requestId })
        }
        if (body.action === 'acknowledge-attempt') {
            const row = journal.get(key)
            if (!row || !completed.has(String(requestId)) || row.requestId !== requestId) return respond({ error: 'Not complete' }, 400)
            row.acknowledged = true
            if (loseAck) { loseAck = false; throw new Error('Lost ack response') }
            return respond({ acknowledged: true, requestId })
        }
        mutations.push({ owner, body }); completed.add(String(requestId))
        if (loseReply) { loseReply = false; throw new Error('Lost response') }
        return respond({ status: 'needs_config', accountKey: 'fixture@aaaaaa' })
    }))
    return { mutations, loseReply: () => { loseReply = true }, loseAck: () => { loseAck = true } }
}
const values = { TOKEN: 'fixture-header-value' }
it('recovers an uncertain install after renderer storage and app origin are lost', async () => {
    const s = server(), client = createDesktopServiceAccountsClient('one')
    s.loseReply()
    await expect(client.install('fixture', 'additional', 'token', values)).rejects.toThrow('Lost response')
    client.dispose(); sessionStorage.clear()
    const restarted = createDesktopServiceAccountsClient('one')
    await restarted.install('fixture', 'additional', 'token', values)
    expect(s.mutations[1].body.requestId).toBe(s.mutations[0].body.requestId)
    await restarted.install('fixture', 'additional', 'token', values)
    expect(s.mutations[2].body.requestId).not.toBe(s.mutations[0].body.requestId)
})
it('does not duplicate an account after a lost acknowledgement, even with a fresh client', async () => {
    const s = server(), client = createDesktopServiceAccountsClient('one')
    s.loseAck()
    await expect(client.install('fixture', 'additional', 'token', values)).rejects.toThrow('Lost ack')
    client.dispose(); sessionStorage.clear()
    await createDesktopServiceAccountsClient('one').install('fixture', 'additional', 'token', values)
    expect(s.mutations[1].body.requestId).toBe(s.mutations[0].body.requestId)
})
it('isolates owner fingerprints and refuses disposed clients before making requests', async () => {
    const s = server(), first = createDesktopServiceAccountsClient('one'), second = createDesktopServiceAccountsClient('two')
    s.loseReply(); await expect(first.install('fixture', 'additional', 'token', values)).rejects.toThrow()
    await second.install('fixture', 'additional', 'token', values)
    expect(s.mutations[0].body.requestId).not.toBe(s.mutations[1].body.requestId)
    first.dispose()
    await expect(first.install('fixture', 'additional', 'token', values)).rejects.toThrow('owner changed')
    expect(s.mutations).toHaveLength(2)
})
