// @vitest-environment happy-dom
// Root executes the regressions. Keep the original command view to retain actual row callbacks.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ControlRow } from '@/components/control-center/types'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import { DesktopControlCenter, type DesktopControlCenterProps } from './DesktopControlCenter'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => {
        if (!elements.has(tag)) elements.set(tag, plain(tag))
        return elements.get(tag)!
    }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})
const rendered = vi.hoisted(() => ({ view: undefined as Parameters<typeof import('@/components/control-center/ControlCenterView')['ControlCenterView']>[0] | undefined }))
vi.mock('@/components/control-center/ControlCenterView', async original => {
    const actual = await original<typeof import('@/components/control-center/ControlCenterView')>()
    return { ...actual, ControlCenterView: (props: Parameters<typeof actual.ControlCenterView>[0]) => {
        rendered.view = props
        return <actual.ControlCenterView {...props} />
    } }
})

const coworkers = [
    { id: 'reviewer', name: 'Reviewer', description: '', createdAt: '', updatedAt: '' },
    { id: 'auditor', name: 'Auditor', description: '', createdAt: '', updatedAt: '' },
]
const roots = new Set<Root>()
const view = () => rendered.view!
const rows = () => view().sections.flatMap(section => section.rows)
const row = (id: string): ControlRow => {
    const result = rows().find(item => item.id === id)
    expect(result, id).toBeDefined()
    return result!
}
const select = (value: ControlRow) => act(async () => { value.onSelect() })
const query = (value: string) => act(async () => { view().onQueryChange(value) })
async function fixture(overrides: Partial<DesktopControlCenterProps> = {}) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.add(root)
    let props: DesktopControlCenterProps = {
        open: true, initialRecent: { revision: 0, recentAgentIds: [] }, coworkers, selectedCoworkerId: 'reviewer',
        onOpenChange: vi.fn(), onOpenConversation: vi.fn(), onOpenCoworker: vi.fn(), onOpenCoworkerPanel: vi.fn(),
        onAddCoworker: vi.fn(), onModelSettings: vi.fn(), onBackToBoard: vi.fn(), ...overrides,
    }
    const update = async (patch: Partial<DesktopControlCenterProps>) => {
        props = { ...props, ...patch }
        await act(async () => { root.render(<DesktopControlCenter {...props} />) })
    }
    await update({})
    return { update, props: () => props }
}
async function drillAuditor() {
    await query('@Auditor')
    await act(async () => { row('coworkers-coworker-auditor').onDrill!() })
}

beforeEach(() => {
    resetDesktopRecentCoworkers()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: [], hasMore: false })
        const match = url.match(/^\/api\/desktop\/agents\/([^/]+)\/control-center-chats$/)
        if (match) return Response.json({ agentId: match[1], openChats: [], recentChats: [], recentStatus: 'ok', hasMore: false })
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => {
    await act(async () => { for (const root of roots) root.unmount() })
    roots.clear()
    resetDesktopRecentCoworkers()
    document.body.innerHTML = ''
    rendered.view = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('Notifications is optional and its global Settings command is found by each original keyword', async () => {
    const app = await fixture()
    await query('/alerts')
    expect(rows().some(item => item.id === 'command-notifications')).toBe(false)
    const onNotifications = vi.fn()
    await app.update({ onNotifications })
    for (const keyword of ['alerts', 'push', 'sound']) {
        await query(`/${keyword}`)
        expect(row('command-notifications').label).toBe('Notifications')
        expect(view().sections.find(section => section.rows.some(item => item.id === 'command-notifications'))?.heading).toBe('Settings')
    }
    await select(row('command-notifications'))
    expect(onNotifications.mock.calls).toEqual([[]])
    expect(app.props().onOpenConversation).not.toHaveBeenCalled()
    expect(app.props().onOpenCoworker).not.toHaveBeenCalled()
})

test('coworker Notifications uses the exact drilled owner and latest callback without selecting its chat', async () => {
    const old = vi.fn(), current = vi.fn()
    const app = await fixture({ onNotifications: old })
    await drillAuditor()
    const retained = row('coworker-notifications')
    expect(retained.detail).toBe('When this agent reaches you')
    expect(view().sections.find(section => section.rows.some(item => item.id === retained.id))?.heading).toBe('Actions')
    await app.update({ onNotifications: current })
    await select(retained)
    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledExactlyOnceWith('auditor')
    expect(app.props().onOpenConversation).not.toHaveBeenCalled()
    expect(app.props().onOpenCoworker).not.toHaveBeenCalled()
    expect(app.props().onOpenCoworkerPanel).not.toHaveBeenCalled()
    await select(retained)
    expect(current).toHaveBeenCalledTimes(1)
})

test.each(['deleted owner', 'removed callback', 'disabled center', 'closed center', 'new query', 'reopened center'] as const)(
    'a retained coworker notification row cannot navigate after %s', async invalidation => {
        const onNotifications = vi.fn()
        const app = await fixture({ onNotifications })
        await drillAuditor()
        const retained = row('coworker-notifications')
        if (invalidation === 'deleted owner') await app.update({ coworkers: [coworkers[0]!] })
        if (invalidation === 'removed callback') await app.update({ onNotifications: undefined })
        if (invalidation === 'disabled center') await app.update({ disabled: true })
        if (invalidation === 'closed center') await app.update({ open: false })
        if (invalidation === 'new query') await query('alerts')
        if (invalidation === 'reopened center') { await app.update({ open: false }); await app.update({ open: true }); await drillAuditor() }
        const closesBefore = vi.mocked(app.props().onOpenChange!).mock.calls.length
        await select(retained)
        expect(onNotifications).not.toHaveBeenCalled()
        expect(vi.mocked(app.props().onOpenChange!).mock.calls).toHaveLength(closesBefore)
        expect(app.props().onOpenConversation).not.toHaveBeenCalled()
        expect(app.props().onOpenCoworker).not.toHaveBeenCalled()
    },
)

test('a retained global command does not close the center after its optional callback is removed', async () => {
    const onNotifications = vi.fn()
    const app = await fixture({ onNotifications })
    await query('/alerts')
    const retained = row('command-notifications')
    await app.update({ onNotifications: undefined })
    expect(rows().some(item => item.id === retained.id)).toBe(false)
    await select(retained)
    expect(onNotifications).not.toHaveBeenCalled()
    expect(app.props().onOpenChange).not.toHaveBeenCalled()
})
