// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { revalidateDesktopCoworkerMentionsAtSend, useDesktopCoworkerMentionTargets } from '@/lib/desktop/coworker-mentions'

const roots: Root[] = []
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const target = (agentId: string): DesktopCoworkerCallTarget => ({ agentId, name: agentId, handle: null, boxName: null, enabled: true, callable: true })

async function mount(agentId = 'owner-a', refreshKey = 'one') {
    let value!: ReturnType<typeof useDesktopCoworkerMentionTargets>
    function Harness(props: { owner: string; refresh: string }) {
        value = useDesktopCoworkerMentionTargets(props.owner, { refreshKey: props.refresh })
        return <span>{value.status}:{value.targets.map(row => row.agentId).join(',')}</span>
    }
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    const render = async (owner = agentId, refresh = refreshKey) => { await act(async () => root.render(<Harness owner={owner} refresh={refresh} />)) }
    await render()
    return { get value() { return value }, render }
}

test('stale owner and same-owner generation responses cannot replace the current roster', async () => {
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    const hook = await mount()
    await hook.render('owner-b', 'one')
    await hook.render('owner-b', 'two')
    await hook.render('owner-b', 'three')
    await act(async () => pending[1]?.(Response.json({ targets: [target('stale-owner')] })))
    expect(hook.value.targets).toEqual([])
    await act(async () => pending[2]?.(Response.json({ targets: [target('stale-generation')] })))
    expect(hook.value.targets).toEqual([])
    await act(async () => pending[0]?.(Response.json({ targets: [target('older-generation')] })))
    expect(hook.value.targets).toEqual([])
    await act(async () => pending[3]?.(Response.json({ targets: [target('current')] })))
    expect(hook.value.targets.map(row => row.agentId)).toEqual(['current'])
})

test('empty, error and unavailable are distinct and retry starts a new generation', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ targets: [] }))
        .mockResolvedValueOnce(Response.json({ error: 'Roster refused.' }, { status: 503 }))
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(Response.json({ targets: [target('peer')] }))
    vi.stubGlobal('fetch', fetcher)
    const hook = await mount()
    expect(hook.value.status).toBe('empty')
    await act(async () => hook.value.retryTargets())
    expect(hook.value.status).toBe('error')
    expect(hook.value.targetError).toBe('Roster refused.')
    await act(async () => hook.value.retryTargets())
    expect(hook.value.status).toBe('unavailable')
    await act(async () => hook.value.retryTargets())
    expect(hook.value.status).toBe('ready')
    expect(hook.value.targets.map(row => row.agentId)).toEqual(['peer'])
})

test('client send revalidation always performs a fresh owner-scoped GET and no mutation', async () => {
    const fetcher = vi.fn(async () => Response.json({ targets: [target('peer')] }))
    vi.stubGlobal('fetch', fetcher)
    const result = await revalidateDesktopCoworkerMentionsAtSend('owner', '@peer review', [{ targetId: 'peer', token: '@peer', start: 0, end: 5 }])
    expect(result).toMatchObject({ ok: true, mentions: [{ targetId: 'peer' }] })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/desktop/coworkers/owner/mentions', { cache: 'no-store', signal: undefined })
})
