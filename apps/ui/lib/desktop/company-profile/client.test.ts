import { afterEach, expect, test, vi } from 'vitest'
import { profileAttempt, profileChat, profileView } from './test-fixtures'
import { createDesktopCompanyProfileClient } from './client'

afterEach(() => vi.unstubAllGlobals())
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('creation has no effects; GET is observational and explicit operations use E v1 envelopes', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(json(profileView))
        .mockResolvedValueOnce(json(profileAttempt('decide')))
        .mockResolvedValueOnce(json(profileAttempt('enrich')))
        .mockResolvedValueOnce(json(profileAttempt('enrich', 'cancelled')))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCompanyProfileClient()
    expect(fetcher).not.toHaveBeenCalled()
    await client.read(profileChat)
    await client.decide({ requestId: '11111111-1111-4111-8111-111111111111', identity: profileView.decisionIdentity! })
    await client.enrich({ requestId: '22222222-2222-4222-8222-222222222222', identity: profileView.enrichmentIdentity!, collect: true })
    await client.cancel({ requestId: '22222222-2222-4222-8222-222222222222', chat: profileChat })
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/desktop/foreman/company-profile?${new URLSearchParams(profileChat)}`)
    for (const [index, action] of ['decide', 'enrich', 'cancel'].entries()) {
        const [url, init] = fetcher.mock.calls[index + 1]!
        expect(url).toBe('/api/desktop/foreman/company-profile')
        expect(JSON.parse(String(init?.body))).toMatchObject({ action })
    }
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).input.identity).toEqual(profileView.decisionIdentity)
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).input.collect).toBe(true)
})

test('refusals and unknown transport failures stay distinguishable', async () => {
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(json({ error: 'The draft changed.' }, 409))
        .mockRejectedValueOnce(new TypeError('offline')))
    const client = createDesktopCompanyProfileClient()
    await expect(client.read(profileChat)).rejects.toMatchObject({ status: 409, message: 'The draft changed.' })
    await expect(client.read(profileChat)).rejects.toMatchObject({ status: null })
})
