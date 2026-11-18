// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopWorkItem, DesktopWorkRegisterView, DesktopWorkRoutineView } from '@rerun/contracts'
import { DesktopWorkRegister, workRoutineCron, workRoutineForm } from './DesktopWorkRegister'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })

const item = (id: string, project: string, extra: Partial<DesktopWorkItem> = {}): DesktopWorkItem => ({
    id, project, owner: { kind: 'coworker', id: 'a1', name: 'Tuner Developer' }, objective: `Objective ${id}`, status: 'working', dependencies: [], blockers: null, important: false,
    nextAction: null, latestUpdate: null, updates: [], evidence: [], approval: null, source: { kind: 'chief', id: null, name: 'Chief of Staff' }, revision: 3,
    createdAt: '2026-11-17T08:00:00.000Z', updatedAt: '2026-11-17T09:00:00.000Z', ...extra,
})
const routine: DesktopWorkRoutineView = { enabled: false, cron: null, timezone: null, scope: '', summaries: false, lastRunAt: null, nextRunAt: null, lastRun: null }
let posts: { url: string; body: unknown }[]
let view: DesktopWorkRegisterView
beforeEach(() => {
    posts = []
    view = {
        items: [
            item('w_1', 'tuner', { nextAction: 'Run the probe', latestUpdate: { text: 'Probe started', at: '2026-11-17T09:00:00.000Z', by: 'Tuner Developer' } }),
            item('w_2', 'server', { status: 'blocked', blockers: 'CI runner offline', owner: { kind: 'coworker', id: 'a2', name: 'Server Developer' } }),
            item('w_3', 'server', { status: 'waiting_approval', approval: { required: 'Deploy 2.4', decides: 'person' }, owner: { kind: 'chief', id: null, name: 'Chief of Staff' } }),
            item('w_4', 'tuner', { status: 'done' }),
        ],
        notices: [{ id: 'n1', kind: 'approval', itemId: 'w_3', title: 'Needs your approval · server', body: 'Deploy 2.4 (Objective w_3)', createdAt: '2026-11-17T09:00:00.000Z' }],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return Response.json(url.endsWith('/routine') ? routine : {}) }
        return Response.json(url.endsWith('/routine') ? routine : view)
    }))
})
async function render() {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopWorkRegister />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}
const button = (label: string, within: ParentNode = document) => [...within.querySelectorAll('button')].find(node => node.textContent === label)!

it('lists open work by project with owner, next action, blocker, approval and latest update', async () => {
    await render()
    expect([...document.querySelectorAll('[data-work-project]')].map(node => node.getAttribute('data-work-project'))).toEqual(['server', 'tuner'])
    const text = document.body.textContent!
    for (const words of ['Tuner Developer', 'Next: Run the probe', 'Blocked: CI runner offline', 'Needs your approval: Deploy 2.4', 'Probe started · Tuner Developer', 'Waiting on approval', 'Needs your approval · server']) expect(text).toContain(words)
    // Closed work is folded away until asked for.
    expect(document.querySelector('[data-work-item="w_4"]')).toBeNull()
    await act(async () => button('Show closed (1)').click())
    expect(document.querySelector('[data-work-item="w_4"]')).not.toBeNull()
})

it('the person only closes items and marks notices read; nothing else is offered', async () => {
    await render()
    const first = document.querySelector('[data-work-item="w_1"]')!
    expect([...first.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Mark done', 'Drop'])
    await act(async () => button('Mark done', first).click())
    await act(async () => button('Mark read').click())
    expect(posts.map(post => post.body)).toEqual([{ action: 'close', id: 'w_1', expectedRevision: 3, status: 'done' }, { action: 'read-notice', id: 'n1' }])
})

it('Coordinate the team starts off, suggesting weekdays at 9:00 and 15:00, and saves the person\'s scope with it', async () => {
    await render()
    const card = document.querySelector('[data-work-routine]')!
    expect(card.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect((card.querySelector('input[aria-label="Times"]') as HTMLInputElement).value).toBe('9:00, 15:00')
    expect((card.querySelector('select') as HTMLSelectElement).value).toBe('weekdays')
    await act(async () => button('Save', card).click())
    expect(posts[0]).toMatchObject({ url: '/api/desktop/work-register/routine', body: { action: 'save', enabled: false, cron: '0 9,15 * * 1-5', scope: '', summaries: false } })
    expect(card.textContent).toContain('Saved.')
})

it('days and times round-trip to one cron, and times on different minutes are refused', () => {
    expect(workRoutineCron('weekdays', '9:00, 15:00')).toEqual({ cron: '0 9,15 * * 1-5' })
    expect(workRoutineCron('every', '7:30')).toEqual({ cron: '30 7 * * *' })
    expect(workRoutineCron('weekdays', '9:00, 15:30')).toHaveProperty('error')
    expect(workRoutineCron('weekdays', '25:00')).toHaveProperty('error')
    expect(workRoutineForm('30 7,18 * * *')).toEqual({ days: 'every', times: '7:30, 18:30' })
    expect(workRoutineForm('0 9 1 * *')).toBeNull()
})
