import { expect, it, vi } from 'vitest'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { createDesktopCoworkerMentionsApi } from './coworker-mentions'

const target: DesktopCoworkerCallTarget = { agentId: 'peer-1', name: 'Researcher', handle: 'researcher', boxName: 'Research', enabled: true, callable: true }

it('returns only explicit safe target fields from the injected current roster authority', async () => {
    const listTargets = vi.fn(async () => [{ ...target, engineAgentId: 'engine-secret', credentials: 'never-return' }])
    const api = createDesktopCoworkerMentionsApi({ listTargets })
    const response = await api(new Request('http://local.test/api/desktop/coworkers/owner-1/mentions'), 'owner-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ targets: [target] })
    expect(listTargets).toHaveBeenCalledWith('owner-1', { signal: expect.any(AbortSignal) })
})

it('reports roster failure without substituting a stale browser roster', async () => {
    const api = createDesktopCoworkerMentionsApi({ listTargets: async () => { throw new Error('roster unavailable') } })
    const response = await api(new Request('http://local.test/api/desktop/coworkers/owner-1/mentions'), 'owner-1')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Coworker suggestions are unavailable.' })
})
