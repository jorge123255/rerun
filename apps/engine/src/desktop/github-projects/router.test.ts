import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyBriefModelRef } from '@rerun/contracts'
import { createDesktopCompanyProfileRouter } from '../company-profile/router.ts'
import { desktopRouteAllowed } from '../policy.js'
import { data } from './fixtures.test-support.ts'

const model: CompanyBriefModelRef = { connectionId: 'selected', provider: 'codex', model: 'profile-purpose', source: 'workspace', agentId: null }
const body = { model, repositories: [data('acme/openflix', { readme: 'An Apple app.' })] }
const post = (app: ReturnType<typeof createDesktopCompanyProfileRouter>, payload: unknown) => app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

describe('the engine route for the intake GitHub projects', () => {
    let saved: string | undefined
    beforeEach(() => { saved = process.env.RERUN_DESKTOP_APP; process.env.RERUN_DESKTOP_APP = '1' })
    afterEach(() => { if (saved === undefined) delete process.env.RERUN_DESKTOP_APP; else process.env.RERUN_DESKTOP_APP = saved })

    it('is a POST the desktop policy admits, beside the website read', () => {
        expect(desktopRouteAllowed('POST', '/desktop/company-profile/projects')).toBe(true)
        expect(desktopRouteAllowed('GET', '/desktop/company-profile/projects')).toBe(false)
    })

    it('answers with the checked summary from the same model adapter as the website read', async () => {
        const adapter = { confirm: vi.fn(async () => true), complete: vi.fn(async () => JSON.stringify({ projects: [{ id: 'acme/openflix', kind: 'ios-app', purpose: 'An Apple app', stack: [], build: null, roles: ['developer', 'qa-tester'] }], links: [] })) }
        const response = await post(createDesktopCompanyProfileRouter(adapter), body)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ status: 'succeeded', projects: [{ id: 'acme/openflix', kind: 'ios-app' }] })
        expect(adapter.confirm).toHaveBeenCalledWith(model)
        expect(adapter.complete.mock.calls[0]![0].prompt).toContain('<repository id="acme/openflix">')
    })

    it('refuses more than twelve repositories, unknown fields and oversized text before any model call', async () => {
        const adapter = { confirm: vi.fn(async () => true), complete: vi.fn(async () => '{}') }
        const app = createDesktopCompanyProfileRouter(adapter)
        expect((await post(app, { model, repositories: Array.from({ length: 13 }, (_, index) => data(`acme/r${index}`)) })).status).toBe(400)
        expect((await post(app, { model, repositories: [{ ...data('acme/a'), token: 'x' }] })).status).toBe(400)
        expect((await post(app, { model, repositories: [data('acme/a', { readme: 'r'.repeat(20 * 1024 + 1) })] })).status).toBe(400)
        expect((await post(app, { model, repositories: [] })).status).toBe(400)
        expect(adapter.confirm).not.toHaveBeenCalled()
    })

    it('does not exist outside the Mac app', async () => {
        process.env.RERUN_DESKTOP_APP = '0'
        expect((await post(createDesktopCompanyProfileRouter({ confirm: async () => true, complete: async () => '{}' }), body)).status).toBe(404)
    })
})
