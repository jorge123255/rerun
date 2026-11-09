import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopScheduleParser } from './schedule-description'

const selection = { agentId: 'alice', connectionId: 'conn-b', provider: 'openai' as const, model: 'gpt-exact' }
const input = { description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00-06:00', timezone: 'America/Chicago', signal: new AbortController().signal }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    fetchMock = vi.fn(async () => Response.json({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' } }))
    vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('createDesktopScheduleParser', () => {
    it('forwards exact selection and local date/timezone to the authenticated UI seam', async () => {
        const result = await createDesktopScheduleParser(selection)(input)

        expect(result).toEqual({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' } })
        expect(fetchMock).toHaveBeenCalledWith('/api/desktop/coworkers/alice/schedule-description', expect.objectContaining({
            method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
        }))
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
            description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00-06:00', timezone: 'America/Chicago',
            connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact',
        })
    })

    it('forwards a saved routine revision without a client-selected model', async () => {
        const expectedRevision = 'a'.repeat(64)
        await createDesktopScheduleParser({ agentId: 'alice', connectionId: null, provider: null, model: null, slug: 'daily', expectedRevision })(input)
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
            slug: 'daily', expectedRevision, connectionId: null, provider: null, model: null,
        })
    })

    it('returns a one-time result without changing its shape', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ status: 'ok', value: { mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' } }))
        await expect(createDesktopScheduleParser(selection)(input)).resolves.toEqual({
            status: 'ok', value: { mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' },
        })
    })

    it('returns explicit parser failure', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ status: 'invalid', message: 'Choose a clearer schedule.' }))
        await expect(createDesktopScheduleParser(selection)(input)).resolves.toEqual({ status: 'invalid', message: 'Choose a clearer schedule.' })
    })

    it('rejects a malformed parser response', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ status: 'ok', value: null, extra: true }))
        await expect(createDesktopScheduleParser(selection)(input)).resolves.toMatchObject({ status: 'invalid' })
    })

    it.each([403, 409, 503])('reports unavailable for HTTP %s without a fake preview', async status => {
        fetchMock.mockResolvedValueOnce(Response.json({ error: 'denied' }, { status }))
        await expect(createDesktopScheduleParser(selection)(input)).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('reports unavailable for a network failure', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'))
        await expect(createDesktopScheduleParser(selection)(input)).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('rethrows caller abort instead of converting it to a result', async () => {
        const controller = new AbortController()
        fetchMock.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted') })

        await expect(createDesktopScheduleParser(selection)({ ...input, signal: controller.signal })).rejects.toThrow('aborted')
    })
})
