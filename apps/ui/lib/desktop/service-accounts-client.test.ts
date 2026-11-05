// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopServiceAccountsClient } from './service-accounts-client'

const bodies: Array<Record<string, unknown> | null> = []
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function respond(payload: Record<string, unknown> | unknown[], status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

it('reuses an install request id and mints a new probe id after an unknown acknowledgement', async () => {
    let probe = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        bodies.push(body)
        expect(String(url)).toContain('/api/desktop/coworkers/coworker-1/service-accounts')
        expect(body).not.toHaveProperty('engineOwnerId')
        if (!body) return respond([])
        if (body.action === 'probe') {
            probe += 1
            return respond(probe === 1 ? { status: 'unknown', message: 'Prior request acknowledgement unavailable; inspect connection state.' } : { status: 'probed', accountKey: 'fixture' })
        }
        return respond({ status: 'needs_config', accountKey: 'fixture' })
    }))
    const client = createDesktopServiceAccountsClient('coworker-1')
    await client.install('fixture', 'new', 'token', { TOKEN: 'fixture-header-value' })
    await client.install('fixture', 'new', 'token', { TOKEN: 'fixture-header-value' })
    const installs = bodies.filter(body => body?.action === 'install')
    expect(installs[0]?.requestId).toBe(installs[1]?.requestId)
    expect(JSON.stringify(installs)).not.toContain('engineOwnerId')
    await expect(client.probe('fixture', '00000000-0000-4000-8000-000000000041')).rejects.toThrow('Prior request acknowledgement unavailable')
    await client.probe('fixture', '00000000-0000-4000-8000-000000000041')
    const probes = bodies.filter(body => body?.action === 'probe')
    expect(probes[0]?.requestId).not.toBe(probes[1]?.requestId)
    client.dispose()
    await expect(client.install('fixture', 'new', 'token', { TOKEN: 'fixture-header-value' })).rejects.toThrow('Service panel owner changed')
    const restarted = createDesktopServiceAccountsClient('coworker-1')
    await restarted.install('fixture', 'new', 'token', { TOKEN: 'fixture-header-value' })
    const again = bodies.filter(body => body?.action === 'install')
    expect(again.at(-1)?.requestId).toBe(installs[0]?.requestId)
})
