// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCompanyProfileAttempt, DesktopCompanyProfileView } from '@rerun/contracts'
import type { DesktopCompanyProfileClient } from './client'
import { decisionIdentity, enrichmentIdentity, profileAttempt, profileChat, profileView } from './test-fixtures'
import { useDesktopCompanyProfile } from './use-desktop-company-profile'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

function clientWith(overrides: Partial<DesktopCompanyProfileClient> = {}): DesktopCompanyProfileClient {
    return {
        read: vi.fn(async () => profileView),
        decide: vi.fn(async () => profileAttempt('decide')),
        enrich: vi.fn(async () => profileAttempt('enrich')),
        cancel: vi.fn(async () => profileAttempt('enrich', 'cancelled')),
        ...overrides,
    }
}

async function mount(client: DesktopCompanyProfileClient) {
    let flow!: ReturnType<typeof useDesktopCompanyProfile>
    function Probe({ revision = 3 }: { revision?: number }) {
        flow = useDesktopCompanyProfile({ chat: profileChat, client, active: true, draftRevision: revision })
        return null
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    return { flow: () => flow, rerender: async (revision: number) => act(async () => root!.render(<Probe revision={revision} />)) }
}

test('restoring a saved view is observational and never starts inference', async () => {
    const client = clientWith()
    const mounted = await mount(client)
    expect(client.read).toHaveBeenCalledOnce()
    expect(client.decide).not.toHaveBeenCalled()
    expect(client.enrich).not.toHaveBeenCalled()
    expect(mounted.flow().view).toEqual(profileView)
    await act(async () => root!.render(<ProbeReplacement client={client} />))
    expect(client.read).toHaveBeenCalledOnce()
})
function ProbeReplacement({ client }: { client: DesktopCompanyProfileClient }) {
    useDesktopCompanyProfile({ chat: profileChat, client, active: true, draftRevision: 3 })
    return null
}

test('explicit decide and enrich bind exact identities and recover the same request after an unknown acknowledgement', async () => {
    const client = clientWith({ decide: vi.fn()
        .mockRejectedValueOnce(new Error('unknown acknowledgement'))
        .mockResolvedValue(profileAttempt('decide')) })
    const mounted = await mount(client)
    await act(async () => { await mounted.flow().decide() })
    await act(async () => { await mounted.flow().decide() })
    expect(vi.mocked(client.decide).mock.calls.map(call => call[0])).toEqual([
        { requestId: profileView.decision!.requestId, identity: decisionIdentity },
        { requestId: profileView.decision!.requestId, identity: decisionIdentity },
    ])
    await act(async () => { await mounted.flow().enrich(true) })
    expect(client.enrich).toHaveBeenCalledExactlyOnceWith({ requestId: profileView.enrichment!.requestId, identity: enrichmentIdentity, collect: true }, expect.any(AbortSignal))
})

test('a changed draft revision fences the previous-site response', async () => {
    let finish!: (attempt: DesktopCompanyProfileAttempt) => void
    const client = clientWith({ decide: vi.fn(() => new Promise<DesktopCompanyProfileAttempt>(resolve => { finish = resolve })) })
    const revised: DesktopCompanyProfileView = {
        ...profileView,
        decisionIdentity: { ...decisionIdentity, draftRevision: 4 },
        enrichmentIdentity: { ...enrichmentIdentity, draftRevision: 4 },
        profile: { ...profileView.profile, name: { ...profileView.profile.name, value: 'New site' } },
    }
    vi.mocked(client.read).mockResolvedValueOnce(profileView).mockImplementation(async () => revised)
    const mounted = await mount(client)
    await act(async () => { void mounted.flow().decide() })
    await mounted.rerender(4)
    await act(async () => finish(profileAttempt('decide')))
    expect(mounted.flow().view?.profile.name.value).toBe('New site')
    expect(mounted.flow().error).toBeNull()
    expect(vi.mocked(client.decide).mock.calls[0]![0].identity.draftRevision).toBe(3)
})

test('Stop cancels only the owned attempt and does not start another analysis', async () => {
    const pendingView = { ...profileView, enrichment: profileAttempt('enrich', 'pending') }
    const client = clientWith({ read: vi.fn(async () => pendingView) })
    const mounted = await mount(client)
    await act(async () => { await mounted.flow().stop('enrich') })
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith({ requestId: pendingView.enrichment.requestId, chat: profileChat })
    expect(client.decide).not.toHaveBeenCalled()
    expect(client.enrich).not.toHaveBeenCalled()
})
