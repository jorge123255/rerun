// @vitest-environment happy-dom
// Authored here; root alone executes the tests and native acceptance checks.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ControlRow } from '@/components/control-center/types'
import type { DesktopAttentionItem } from '@/lib/desktop/attention'
import type { BoardActivitySnapshot } from '@/lib/desktop/board-activity'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import * as draftWrites from '@/lib/desktop/draft-writes'
import { DesktopControlCenter, type DesktopControlCenterProps } from './DesktopControlCenter'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Exercise the actual desktop adapter and its retained callbacks. The shared view's keyboard,
// dialog and visual behavior has its own coverage; capturing its contract avoids animation timers.
const rendered = vi.hoisted(() => ({ view: undefined as Parameters<typeof import('@/components/control-center/ControlCenterView')['ControlCenterView']>[0] | undefined }))
vi.mock('@/components/control-center/ControlCenterView', () => ({
    ControlCenterView: (props: Parameters<typeof import('@/components/control-center/ControlCenterView')['ControlCenterView']>[0]) => {
        rendered.view = props
        return null
    },
}))

const coworker = (id: string, name = id, enabled = true) => ({ id, name, enabled, description: '', createdAt: '', updatedAt: '' })
const pending = (agentId = 'ada', overrides: Partial<DesktopAttentionItem> = {}): DesktopAttentionItem => ({
    id: `${agentId}-request`, kind: 'question', agentId, agentName: agentId, agentEnabled: true,
    sessionId: `${agentId}-pending-chat`, title: `${agentId} pending request`, summary: 'Choose a color',
    updatedAt: '2026-11-04T12:00:00.000Z', ...overrides,
})
const activity = (items: DesktopAttentionItem[] = [pending()], statuses: BoardActivitySnapshot['statuses'] = { ada: 'waiting_human', bob: 'idle' }): BoardActivitySnapshot => ({
    statuses,
    attention: { items, unavailableAgentIds: Object.keys(statuses).filter(id => statuses[id] === 'unreachable'), checkedAt: '2026-11-04T12:00:01.000Z' },
})
const section = (id: string) => rendered.view?.sections.find(entry => entry.id === id)
const rows = () => rendered.view?.sections.flatMap(entry => entry.rows) ?? []
function row(id = 'needs-you-coworker-ada'): ControlRow {
    const found = rows().find(entry => entry.id === id)
    expect(found, id).toBeDefined()
    return found!
}
const select = (entry: ControlRow) => act(async () => { entry.onSelect() })
const query = (value: string) => act(async () => { rendered.view!.onQueryChange(value) })

const roots = new Set<Root>()
function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.add(root)
    return root
}
const render = (root: Root, props: Partial<DesktopControlCenterProps> = {}) => act(async () => {
    root.render(<DesktopControlCenter
        open
        initialRecent={{ revision: 0, recentAgentIds: [] }}
        coworkers={[coworker('ada', 'Ada'), coworker('bob', 'Bob')]}
        selectedCoworkerId={null}
        onOpenConversation={() => {}}
        onAddCoworker={() => {}}
        onModelSettings={() => {}}
        onBackToBoard={() => {}}
        {...props}
    />)
})

beforeEach(() => {
    resetDesktopRecentCoworkers()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: [], hasMore: false })
        const match = url.match(/^\/api\/desktop\/agents\/([^/]+)\/control-center-chats$/)
        if (match) return Response.json({ agentId: decodeURIComponent(match[1]), openChats: [], recentChats: [], recentStatus: 'ok', hasMore: false })
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => {
    for (const root of roots) await act(async () => { root.unmount() })
    roots.clear()
    resetDesktopRecentCoworkers()
    rendered.view = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('Needs you precedes Recent in roster order without the ordinary eight-coworker cap or duplicates', async () => {
    const waiting = Array.from({ length: 10 }, (_, index) => coworker(`waiting-${index}`, `Waiting ${index}`))
    const coworkers = [waiting[4]!, coworker('idle', 'Idle'), ...waiting.filter((_, index) => index !== 4)]
    const snapshot = activity(waiting.map(owner => pending(owner.id)).reverse(), {
        idle: 'idle', ...Object.fromEntries(waiting.map(owner => [owner.id, 'waiting_human' as const])),
    })
    await render(mount(), { coworkers, activity: snapshot, initialRecent: { revision: 3, recentAgentIds: ['waiting-0', 'idle', 'waiting-4'] } })
    expect(rendered.view!.sections.filter(entry => entry.rows.length).slice(0, 2).map(entry => entry.heading)).toEqual(['Needs you', 'Recent'])
    expect(section('needs-you')!.rows.map(entry => entry.label)).toEqual(coworkers.filter(owner => owner.id !== 'idle').map(owner => owner.name))
    expect(section('needs-you')!.rows).toHaveLength(10)
    expect(section('recent')!.rows.map(entry => entry.label)).toEqual(['Idle'])
    expect(section('needs-you')!.rows.every(entry => entry.badge?.label === 'Needs you' && entry.badge.tone === 'orange')).toBe(true)
})

test('the fallback excludes waiting rows and retains Off, Working and unavailable precedence', async () => {
    const coworkers = [coworker('ada', 'Ada'), coworker('working', 'Working'), coworker('off', 'Off', false), coworker('lost', 'Lost'), coworker('empty', 'No confirmed request')]
    await render(mount(), { coworkers, activity: activity([pending(), pending('working'), pending('off'), pending('lost')], {
        ada: 'waiting_human', working: 'working', off: 'waiting_human', lost: 'unreachable', empty: 'waiting_human',
    }) })
    expect(section('needs-you')!.rows.filter(entry => entry.id.startsWith('needs-you-coworker-')).map(entry => entry.label)).toEqual(['Ada'])
    expect(section('coworkers')!.rows.some(entry => entry.label === 'Ada')).toBe(false)
    expect(row('coworkers-coworker-working').badge).toEqual({ label: 'Working', tone: 'cyan' })
    expect(row('coworkers-coworker-off').badge).toEqual({ label: 'Off', tone: 'neutral' })
    expect(row('coworkers-coworker-lost').badge?.tone).toBe('neutral')
})

test('one coworker row opens its newest confirmed pending chat instead of the selected chat', async () => {
    const onOpenConversation = vi.fn(), onOpenCoworker = vi.fn(), onOpenChange = vi.fn()
    const old = pending('ada', { id: 'old-question', sessionId: 'older-chat', updatedAt: '2026-11-04T11:00:00Z' })
    const newest = pending('ada', { id: 'new-approval', kind: 'approval', sessionId: 'approval-chat', title: 'Approve the plan' })
    await render(mount(), { activity: activity([old, newest]), selectedCoworkerId: 'ada', onOpenConversation, onOpenCoworker, onOpenChange })
    expect(section('needs-you')!.rows.filter(entry => entry.id.startsWith('needs-you-coworker-'))).toHaveLength(1)
    await select(row())
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'approval-chat', agentId: 'ada', agentName: 'Ada', title: 'Approve the plan' })
    expect(onOpenCoworker).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test.each(['/', '@', 'Ada'])('query %s keeps its original scope without a Needs you section', async value => {
    await render(mount(), { activity: activity() })
    expect(section('needs-you')).toBeDefined()
    await query(value)
    expect(section('needs-you')).toBeUndefined()
})

test('drilling a waiting coworker retains the original coworker page rather than the root Needs you list', async () => {
    await render(mount(), { activity: activity() })
    const drill = row().onDrill
    expect(drill).toBeDefined()
    await act(async () => { drill!() })
    expect(section('needs-you')).toBeUndefined()
    expect(rendered.view!.pageKey).toBe('coworker:ada')
    expect(rendered.view!.placeholder).toContain('Ada')
})

test('omitting the optional activity prop preserves isolated Control Center compatibility', async () => {
    await render(mount())
    expect(section('needs-you')).toBeUndefined()
})

test.each([{}, { ada: 'unknown', bob: 'unknown' }] as const)('initial activity has a loading section and no invented waiting rows', async statuses => {
    const snapshot: BoardActivitySnapshot = { statuses, attention: { items: [], unavailableAgentIds: [], checkedAt: '' } }
    await render(mount(), { activity: snapshot })
    expect(section('needs-you')?.loading).toBe(true)
    expect(rows().some(entry => entry.id.startsWith('needs-you-coworker-'))).toBe(false)
})

test('a partial activity read preserves its confirmed rows and offers a real refresh action', async () => {
    const onRefreshActivity = vi.fn(async () => activity())
    const onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    await render(mount(), { activity: activity([pending()], { ada: 'waiting_human', bob: 'unreachable' }), onRefreshActivity, onOpenConversation, onOpenChange })
    expect(row().label).toBe('Ada')
    expect(row('needs-you-retry').label).toBe('Could not check all coworkers')
    await select(row('needs-you-retry'))
    expect(onRefreshActivity).toHaveBeenCalledTimes(1)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

type Changed = 'resolved' | 'new request' | 'different kind' | 'different session' | 'working' | 'unknown' | 'unreachable' | 'disabled target'
function changedSnapshot(change: Changed): BoardActivitySnapshot {
    if (change === 'resolved') return activity([], { ada: 'idle', bob: 'idle' })
    if (change === 'new request') return activity([pending('ada', { id: 'replacement-request' })])
    if (change === 'different kind') return activity([pending('ada', { kind: 'approval' })])
    if (change === 'different session') return activity([pending('ada', { sessionId: 'another-chat' })])
    if (change === 'disabled target') return activity([pending('ada', { agentEnabled: false })])
    return activity([pending()], { ada: change, bob: 'idle' })
}
const changes: Changed[] = ['resolved', 'new request', 'different kind', 'different session', 'working', 'unknown', 'unreachable', 'disabled target']

test.each(changes)('a retained Needs you callback cannot navigate after the activity becomes %s', async change => {
    const root = mount(), onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    const props = { onOpenConversation, onOpenChange }
    await render(root, { ...props, activity: activity() })
    const previous = row()
    await render(root, { ...props, activity: changedSnapshot(change) })
    await select(previous)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test.each(['removed', 'disabled'] as const)('a retained Needs you callback cannot navigate after its owner is %s', async change => {
    const root = mount(), onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    const props = { onOpenConversation, onOpenChange, activity: activity() }
    await render(root, props)
    const previous = row()
    await render(root, { ...props, coworkers: change === 'removed' ? [coworker('bob', 'Bob')] : [coworker('ada', 'Ada', false), coworker('bob', 'Bob')] })
    await select(previous)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test('selection waits for a fresh unchanged identity before opening the exact pending chat', async () => {
    const root = mount(), onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    let resolve!: (snapshot: BoardActivitySnapshot | null) => void
    const onRefreshActivity = vi.fn(() => new Promise<BoardActivitySnapshot | null>(done => { resolve = done }))
    await render(root, { activity: activity(), onOpenConversation, onOpenChange, onRefreshActivity })
    await select(row())
    expect(onRefreshActivity).toHaveBeenCalledTimes(1)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => { resolve(activity()) })
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'ada-pending-chat', agentId: 'ada', agentName: 'Ada', title: 'ada pending request' })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test.each([...changes, 'failed read', 'rejected read'] as const)('selection cannot navigate when its fresh activity is %s', async change => {
    const onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    const onRefreshActivity = vi.fn(async () => {
        if (change === 'rejected read') throw new Error('Activity unavailable')
        return change === 'failed read' ? null : changedSnapshot(change)
    })
    await render(mount(), { activity: activity(), onOpenConversation, onOpenChange, onRefreshActivity })
    await select(row())
    expect(onRefreshActivity).toHaveBeenCalledTimes(1)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test.each(['close/reopen', 'query', 'disabled', 'owner removed', 'resolved', 'working', 'quit'] as const)('a late refresh cannot revive navigation after %s', async change => {
    const root = mount(), onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    let resolve!: (snapshot: BoardActivitySnapshot | null) => void
    const onRefreshActivity = vi.fn(() => new Promise<BoardActivitySnapshot | null>(done => { resolve = done }))
    const props = { activity: activity(), onOpenConversation, onOpenChange, onRefreshActivity }
    await render(root, props)
    await select(row())
    expect(onRefreshActivity).toHaveBeenCalledTimes(1)
    if (change === 'close/reopen') {
        await render(root, { ...props, open: false })
        await render(root, { ...props, open: true })
    } else if (change === 'query') await query('/')
    else if (change === 'disabled') await render(root, { ...props, disabled: true })
    else if (change === 'owner removed') await render(root, { ...props, coworkers: [coworker('bob', 'Bob')] })
    else if (change === 'resolved' || change === 'working') await render(root, { ...props, activity: changedSnapshot(change) })
    else vi.spyOn(draftWrites, 'isDesktopQuitting').mockReturnValue(true)
    // Disabling the entire center legitimately closes it. The late refresh must not add a
    // second close or any navigation after that lifecycle action.
    onOpenChange.mockClear()
    await act(async () => { resolve(activity()) })
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test.each(['old first', 'new first'] as const)('a reopened center can make a new selection while its old refresh is pending (%s)', async order => {
    const root = mount(), onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    const finish: Array<(snapshot: BoardActivitySnapshot | null) => void> = []
    const onRefreshActivity = vi.fn(() => new Promise<BoardActivitySnapshot | null>(resolve => { finish.push(resolve) }))
    const props = { activity: activity(), onOpenConversation, onOpenChange, onRefreshActivity }
    await render(root, props)
    await select(row())
    await render(root, { ...props, open: false })
    await render(root, { ...props, open: true })
    await select(row())
    expect(onRefreshActivity).toHaveBeenCalledTimes(2)
    if (order === 'old first') {
        await act(async () => { finish[0]!(activity()) })
        expect(onOpenConversation).not.toHaveBeenCalled()
        expect(onOpenChange).not.toHaveBeenCalled()
        await act(async () => { finish[1]!(activity()) })
    } else {
        await act(async () => { finish[1]!(activity()) })
        await act(async () => { finish[0]!(activity()) })
    }
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'ada-pending-chat', agentId: 'ada', agentName: 'Ada', title: 'ada pending request' })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})
