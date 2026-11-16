// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopActivityRow, DesktopActivityView } from '@/lib/desktop/activity'
import { DesktopActivityPanel } from './DesktopActivityDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })

const row = (overrides: Partial<DesktopActivityRow> = {}): DesktopActivityRow => ({
    seq: 2, id: 'r2', at: '2026-11-16T09:00:00.000Z', coworker: 'Scout', coworkerId: 'app-scout', deleted: false, conversationId: 'chat-1', sentence: 'Scout sent email with Gmail: allowed once by you',
    outcome: 'allowed-once-by-person', ruleWords: 'Ask first: sending to other people', tool: 'GMAIL_SEND_EMAIL', action: null, app: 'Gmail', kind: 'send', source: 'routine', sourceSlug: 'weekly-report', durationMs: 1500, summary: 'to: pat@example.test', ...overrides,
})
const view = (overrides: Partial<DesktopActivityView> = {}): DesktopActivityView => ({ rows: [], next: null, total: 0, dropped: 0, coworkers: [{ id: 'app-scout', name: 'Scout' }, { id: 'app-ledger', name: 'Ledger' }], ...overrides })

async function settle() { for (let index = 0; index < 4; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount(answers: (url: string, init?: RequestInit) => unknown, onOpenConversation?: (target: { agentId: string; sessionId: string }) => Promise<void>) {
    const requests: { url: string; method: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET' })
        const answer = answers(String(url), init)
        return answer instanceof Response ? answer : Response.json(answer)
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<DesktopActivityPanel onOpenConversation={onOpenConversation} />) })
    await settle()
    return { host, requests }
}
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label)!
function choose(element: HTMLSelectElement | HTMLInputElement, value: string) {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

test('an empty trail explains what will appear here', async () => {
    const { host, requests } = await mount(() => view())
    expect(requests).toEqual([{ url: '/api/desktop/activity?', method: 'GET' }])
    expect(host.textContent).toContain('No activity yet')
    expect(host.textContent).toContain('whether it was allowed by a permission, allowed once by you, declined or refused, and by which rule')
    expect(host.textContent).toContain('Kept on this Mac for 90 days')
    expect(button('Export CSV').disabled).toBe(true)
    expect(button('Clear activity').disabled).toBe(true)
    expect(host.querySelector('[role=status]')).toBeNull()
})

test('rows read in plain words, newest first, and a row opens its conversation', async () => {
    const opened = vi.fn(async () => {})
    const { host } = await mount(() => view({ total: 2, dropped: 3, rows: [
        row(),
        row({ seq: 1, id: 'r1', coworker: 'Deleted coworker', coworkerId: null, deleted: true, conversationId: null, sentence: 'Deleted coworker was refused: Edit shared files is off', outcome: 'refused-no-permission', ruleWords: 'Permission: Edit shared files', source: 'chat', sourceSlug: null, durationMs: null, summary: null }),
    ] }), opened)
    const rows = [...host.querySelectorAll('[data-activity-row]')]
    expect(rows.map(node => node.getAttribute('data-outcome'))).toEqual(['allowed-once-by-person', 'refused-no-permission'])
    expect(rows[0]!.textContent).toContain('Scout sent email with Gmail: allowed once by you')
    expect(rows[0]!.textContent).toContain('Routine: weekly-report · Ask first: sending to other people · 1.5 s')
    expect(rows[0]!.textContent).toContain('to: pat@example.test')
    expect(rows[1]!.textContent).toContain('Deleted coworker was refused: Edit shared files is off')
    expect(host.querySelector('[role=status]')!.textContent).toContain('3 actions could not be recorded.')
    expect(host.textContent).toContain('2 actions')
    // A deleted coworker's row has no conversation to open.
    expect(rows[1]!.querySelector('button')).toBeNull()
    await act(async () => { rows[0]!.querySelector('button')!.click() })
    expect(opened).toHaveBeenCalledWith({ agentId: 'app-scout', sessionId: 'chat-1' })
})

test('filters and search narrow the request, and older rows load on demand', async () => {
    const { host, requests } = await mount(url => url.includes('before=5')
        ? view({ total: 9, rows: [row({ seq: 4, id: 'r4', sentence: 'Scout read a file: done' })] })
        : view({ total: 9, next: 5, rows: [row({ seq: 5, id: 'r5' })] }))
    choose(host.querySelector<HTMLSelectElement>('select[aria-label="Coworker"]')!, 'app-ledger')
    await settle()
    choose(host.querySelector<HTMLSelectElement>('select[aria-label="Outcome"]')!, 'declined-by-person')
    await settle()
    choose(host.querySelector<HTMLSelectElement>('select[aria-label="Started by"]')!, 'routine')
    await settle()
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    await settle()
    expect(requests.at(-1)!.url).toBe('/api/desktop/activity?coworker=app-ledger&outcome=declined-by-person&source=routine&risky=1')
    expect([...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Coworker"] option')].map(option => option.textContent)).toEqual(['All coworkers', 'Scout', 'Ledger', 'Deleted coworkers'])
    choose(host.querySelector<HTMLInputElement>('input[aria-label="From date"]')!, '2026-11-01')
    await settle()
    expect(new URL(requests.at(-1)!.url, 'http://x').searchParams.get('from')).toBe(new Date(2026, 10, 1).toISOString())
    await act(async () => { button('Show older activity').click() })
    await settle()
    expect(requests.at(-1)!.url).toContain('&before=5')
    expect(host.querySelectorAll('[data-activity-row]')).toHaveLength(2)
    expect(host.textContent).toContain('9 actions match')
    await act(async () => { button('Clear filters').click() })
    await settle()
    expect(requests.at(-1)!.url).toBe('/api/desktop/activity?')
    vi.useFakeTimers()
    await act(async () => { choose(host.querySelector<HTMLInputElement>('input[aria-label="Search tools and apps"]')!, 'gmail') })
    const before = requests.length
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(requests.slice(before).map(request => request.url)).toEqual(['/api/desktop/activity?q=gmail'])
})

test('a filter with no matches says so rather than showing the first-run text', async () => {
    const { host } = await mount(url => url.includes('risky=1') ? view() : view({ total: 1, rows: [row()] }))
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    await settle()
    expect(host.textContent).toContain('Nothing matches these filters')
    expect(host.textContent).not.toContain('No activity yet')
})

test('Clear activity asks first, then clears everything and reads again', async () => {
    let cleared = false
    const { host, requests } = await mount((_url, init) => {
        if (init?.method === 'DELETE') { cleared = true; return { cleared: true } }
        return cleared ? view() : view({ total: 1, rows: [row()] })
    })
    await act(async () => { button('Clear activity').click() })
    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
    expect(document.body.textContent).toContain('Clear all activity?')
    expect(document.body.textContent).toContain('It cannot be undone.')
    const confirm = [...document.querySelectorAll('[role=alertdialog] button')].find(node => node.textContent === 'Clear activity') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await settle()
    expect(requests.filter(request => request.method === 'DELETE')).toEqual([{ url: '/api/desktop/activity', method: 'DELETE' }])
    expect(host.textContent).toContain('No activity yet')
})

test('Export CSV saves the current filter, and a failure is said plainly', async () => {
    let fail = false
    const created: Blob[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:activity' }, revokeObjectURL: () => {} }))
    const clicked: string[] = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { clicked.push(this.download) }
    try {
        const { host, requests } = await mount(url => url.includes('/export') ? (fail ? new Response('no', { status: 502 }) : new Response('time,coworker\r\n', { headers: { 'content-type': 'text/csv' } })) : view({ total: 1, rows: [row()] }))
        await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
        await settle()
        await act(async () => { button('Export CSV').click() })
        await settle()
        expect(requests.at(-1)!.url).toBe('/api/desktop/activity/export?risky=1')
        expect(clicked).toHaveLength(1)
        expect(clicked[0]).toMatch(/^rerun-activity-\d{4}-\d{2}-\d{2}\.csv$/)
        expect(await created[0]!.text()).toBe('time,coworker\r\n')
        fail = true
        await act(async () => { button('Export CSV').click() })
        await settle()
        expect(host.querySelector('[role=alert]')!.textContent).toBe('Could not export the activity. Try again.')
    } finally { HTMLAnchorElement.prototype.click = click }
})
