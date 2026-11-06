import { describe, expect, it } from 'vitest'
import { bindDesktopScheduleToolNotices, desktopScheduleToolNoticeRequest, desktopScheduleToolNoticesWired } from './notices'

const notice = { localAgentId: 'local-1', engineAgentId: 'eng-1', slug: 'weekly-report', operation: 'create' as const, outcome: 'committed' as const, revision: 'abc', at: '2026-09-30T06:00:00.000Z' }

describe('desktop schedule tool notices', () => {
    it('stays unavailable until bound, then records a committed edit without reading a routine', async () => {
        if (!desktopScheduleToolNoticesWired()) {
            const blocked = await desktopScheduleToolNoticeRequest(new Request('http://local/notices'), 'local-1')
            expect(blocked.status).toBe(503)
            bindDesktopScheduleToolNotices()
        }
        const saved = await desktopScheduleToolNoticeRequest(new Request('http://local/notices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(notice) }), 'local-1')
        expect(saved.status).toBe(200)
        const listed = await desktopScheduleToolNoticeRequest(new Request('http://local/notices'), 'local-1')
        expect(await listed.json()).toEqual({ notices: expect.arrayContaining([notice]) })
        const mismatched = await desktopScheduleToolNoticeRequest(new Request('http://local/notices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(notice) }), 'other')
        expect(mismatched.status).toBe(403)
        const removed = await desktopScheduleToolNoticeRequest(new Request('http://local/notices', { method: 'DELETE' }), 'local-1')
        expect(removed.status).toBe(405)
    })
})
