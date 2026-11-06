import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(async () => ({ dataRoot: '/fixture' })), engine: vi.fn(async () => ({ dataRoot: '/fixture' })), owner: vi.fn(async (_db: unknown, id: string) => ({ id, engineAgentId: id === 'local-1' ? 'eng-1' : 'other-engine' })) }))
vi.mock('../auth', async () => { const actual = await vi.importActual<typeof import('../auth')>('../auth'); return { ...actual, authenticateDesktopRequest: mocks.auth, authenticateDesktopEngineRequest: mocks.engine } })
vi.mock('../database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('../store', () => ({ findDesktopAgent: mocks.owner }))
import { desktopScheduleToolNoticeRequest } from './notices'
const notice = { localAgentId: 'local-1', engineAgentId: 'eng-1', slug: 'weekly-report', operation: 'create', outcome: 'committed', revision: 'abc', at: '2026-09-30T06:00:00.000Z' }
describe('desktop schedule tool notices', () => {
 it('authenticates engine writes, binds exact owners and projects public fields for reads', async () => {
  const save = () => new Request('http://local/notices', { method: 'POST', body: JSON.stringify(notice) })
  expect((await desktopScheduleToolNoticeRequest(save(), 'local-1')).status).toBe(200)
  expect(mocks.engine).toHaveBeenCalled()
  const result = await desktopScheduleToolNoticeRequest(new Request('http://local/notices'), 'local-1')
  const data = await result.json(); expect(mocks.auth).toHaveBeenCalled(); expect(data.notices[0].engineAgentId).toBeUndefined()
  expect((await desktopScheduleToolNoticeRequest(save(), 'other')).status).toBe(403)
 })
})
