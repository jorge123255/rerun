import { Hono } from 'hono'
import { DESKTOP_ACTIVITY_OUTCOMES, DESKTOP_ACTIVITY_SOURCES, type DesktopActivityFilters, type DesktopActivityOutcome, type DesktopActivityPage, type DesktopActivitySource } from '@rerun/contracts'
import { desktopActivityDroppedUnsaved, resetDesktopActivityDropped, settleDesktopActivity } from './recorder.js'
import { openActivityStore, type ActivityStore } from './store.js'

const list = (value: string | undefined) => value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 500)
const moment = (value: string | undefined) => {
    if (!value) return undefined
    const time = Date.parse(value)
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/** The filters a request carries in its query string; an unknown outcome or source is ignored. */
export function desktopActivityFiltersOf(query: Record<string, string | undefined>): DesktopActivityFilters {
    const outcomes = list(query.outcomes)?.filter((value): value is DesktopActivityOutcome => (DESKTOP_ACTIVITY_OUTCOMES as readonly string[]).includes(value))
    const sources = list(query.sources)?.filter((value): value is DesktopActivitySource => (DESKTOP_ACTIVITY_SOURCES as readonly string[]).includes(value))
    return {
        ...(query.agents !== undefined ? { agentIds: list(query.agents) } : {}),
        ...(query.except !== undefined ? { excludeAgentIds: list(query.except) } : {}),
        ...(outcomes?.length ? { outcomes } : {}),
        ...(sources?.length ? { sources } : {}),
        ...(query.risky === '1' ? { risky: true } : {}),
        ...(moment(query.from) ? { from: moment(query.from) } : {}),
        ...(moment(query.to) ? { to: moment(query.to) } : {}),
        ...(query.q?.trim() ? { search: query.q.trim().slice(0, 100) } : {}),
    }
}

/** Read and clear the workspace's activity trail. The Mac app is the only caller. */
export function createDesktopActivityRouter(open: () => Promise<ActivityStore> = openActivityStore) {
    const router = new Hono()
    router.get('/', async c => {
        await settleDesktopActivity()
        const store = await open()
        const before = Number(c.req.query('before'))
        const limit = Number(c.req.query('limit'))
        const page = await store.list(desktopActivityFiltersOf(c.req.query()), { before: Number.isSafeInteger(before) && before > 0 ? before : null, ...(Number.isFinite(limit) ? { limit } : {}) })
        const body: DesktopActivityPage = { ...page, dropped: await store.dropped() + desktopActivityDroppedUnsaved() }
        return c.json(body, 200, { 'cache-control': 'no-store' })
    })
    router.delete('/', async c => {
        await settleDesktopActivity()
        await (await open()).clear()
        resetDesktopActivityDropped()
        return c.json({ cleared: true })
    })
    return router
}
