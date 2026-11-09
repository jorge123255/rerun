// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('@/lib/desktop/use-schedule-tool-notices', () => ({ useDesktopScheduleToolNotices: () => null }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/agent/RunModelField', () => ({
    RunModelField: ({ value, onChange }: { value: { connectionId: string | null; model: string | null }; onChange: (next: { connectionId: string | null; model: string | null }) => void }) => <div data-testid="routine-model" data-connection={value.connectionId ?? ''} data-model={value.model ?? ''}>
        <button onClick={() => onChange({ connectionId: 'conn-b', model: 'gpt-exact' })}>Use exact model</button>
        <button onClick={() => onChange({ connectionId: null, model: null })}>Use coworker default</button>
    </div>,
}))
import { DesktopCoworkerSchedules } from './DesktopCoworkerSchedules'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const grantMessage = 'Enable Schedules in this coworker’s Capabilities to use routines'
const task = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug, name: `Saved ${slug}`, description: '', body: 'Return a short report.', enabled: true,
    cron: '0 8 * * *', runAt: null, timezone: 'America/Chicago', nextRunAt: null,
    connectionId: null, provider: null, model: null,
    lastResult: null, lastResultUnknown: false, ...extra,
})
const modelView = {
    catalog: [{ connectionId: 'conn-b', name: 'OpenAI B', provider: 'openai', models: [{ id: 'gpt-exact', label: 'Exact model' }] }],
    workspace: null,
    coworker: { connectionId: null, provider: null, model: 'coworker-model', label: 'Coworker model', available: true },
    conversation: null,
    effective: { source: 'coworker', connectionId: null, provider: null, name: null, model: 'coworker-model', label: 'Coworker model', available: true },
}
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, respond: (url: string, init?: RequestInit) => Promise<Response>
let putBodies: Array<{ input?: Record<string, unknown> }>
beforeEach(() => {
    putBodies = []
    respond = async () => Response.json([task('daily'), task('weekly'), task('monthly')])
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => respond(String(url), init)))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(async () => { root.render(<DesktopCoworkerSchedules agentId="alice" onOpenSession={vi.fn()} />) })
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!
const row = (name: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.includes(name))!
const refresh = () => act(async () => { button('Refresh').click() })
function deferred() {
    let resolve!: (value: Response) => void
    const promise = new Promise<Response>(done => { resolve = done })
    return { promise, resolve }
}

test('a denied initial read preserves the Capabilities guidance without claiming zero tasks, and Refresh recovers', async () => {
    respond = async () => Response.json({ error: grantMessage }, { status: 403 })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(grantMessage)
    expect(container.textContent).not.toContain('0 scheduled tasks')
    expect(container.textContent).not.toContain('No scheduled tasks yet')
    expect(button('New').disabled).toBe(true)
    await act(async () => { button('New').click() })
    expect(container.textContent).not.toContain('New task')
    expect(fetch).toHaveBeenCalledTimes(1)

    const pending = deferred(); respond = () => pending.promise
    await refresh()
    expect(button('New').disabled).toBe(true)
    expect(container.textContent).not.toContain('No scheduled tasks yet')
    await act(async () => { pending.resolve(Response.json([task('daily'), task('weekly'), task('monthly')])) })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('3 scheduled tasks')
    expect(row('Saved monthly')).toBeDefined()
    expect(button('New').disabled).toBe(false)
})

test('loading is unknown until a successful empty list arrives', async () => {
    const pending = deferred(); respond = () => pending.promise
    await render()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading scheduled tasks…')
    expect(container.textContent).not.toContain('0 scheduled tasks')
    expect(container.textContent).not.toContain('No scheduled tasks yet')
    expect(button('New').disabled).toBe(true)
    await act(async () => { pending.resolve(Response.json([])) })
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).toContain('0 scheduled tasks')
    expect(container.textContent).toContain('No scheduled tasks yet')
    expect(button('New').disabled).toBe(false)
})

test('refresh retains visible saved rows through loading and failure, then replaces them only after a successful response', async () => {
    await render()
    const daily = row('Saved daily'), weekly = row('Saved weekly')
    expect(daily).toBeDefined(); expect(weekly).toBeDefined()
    const pending = deferred(); respond = () => pending.promise
    await refresh()
    expect(row('Saved daily')).toBe(daily)
    expect(button('New').disabled).toBe(true)
    await act(async () => { pending.resolve(Response.json({ error: grantMessage }, { status: 403 })) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(grantMessage)
    expect(row('Saved daily')).toBe(daily)
    expect(row('Saved weekly')).toBe(weekly)
    expect(container.textContent).toContain('Showing previously loaded tasks.')
    expect(container.textContent).not.toContain('0 scheduled tasks')
    expect(container.textContent).not.toContain('No scheduled tasks yet')
    expect(button('New').disabled).toBe(true)

    respond = async () => Response.json([task('daily'), task('updated')])
    await refresh()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('2 scheduled tasks')
    expect(container.textContent).not.toContain('Showing previously loaded tasks.')
    expect(row('Saved daily')).toBe(daily)
    expect(row('Saved weekly')).toBeUndefined()
    expect(row('Saved updated')).toBeDefined()
    expect(button('New').disabled).toBe(false)
})

test('transport errors and malformed successful payloads remain failures without exposing transport details', async () => {
    respond = async () => { throw new Error('Internal transport address and credentials must stay private') }
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load scheduled tasks')
    expect(container.textContent).not.toContain('Internal transport')
    respond = async () => Response.json({ schedules: [] })
    await refresh()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load scheduled tasks')
    expect(container.textContent).not.toContain('0 scheduled tasks')
    expect(container.textContent).not.toContain('No scheduled tasks yet')
    expect(button('New').disabled).toBe(true)
})


function exactModelResponses(tasks: Array<ReturnType<typeof task>> = [task('daily')]) {
    respond = async (url, init) => {
        if (url.endsWith('/model')) return Response.json(modelView)
        if (init?.method === 'PUT') {
            putBodies.push(JSON.parse(String(init.body)))
            return Response.json({ slug: 'saved' })
        }
        return Response.json(tasks)
    }
}

async function setControlValue(selector: string, value: string) {
    const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    await act(async () => { control.dispatchEvent(new Event('input', { bubbles: true })) })
}

test('an exact catalog selection is saved with its connection provider and model', async () => {
    exactModelResponses()
    await render()
    await act(async () => { button('New').click() })
    await setControlValue('input[aria-label="Name"]', 'Exact routine')
    await setControlValue('textarea', 'Use the exact model')
    await act(async () => { button('Use exact model').click() })
    await act(async () => { button('Create task').click() })

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].input).toMatchObject({ connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' })
})

test('an existing all-null row keeps coworker-default semantics when saved', async () => {
    exactModelResponses()
    await render()
    await act(async () => { row('Saved daily').click() })
    await act(async () => { button('Save changes').click() })

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].input).toMatchObject({ connectionId: null, provider: null, model: null })
})

test('an unavailable saved pin stays exact blocks Test Run and permits non-substituting edits', async () => {
    exactModelResponses([task('stale', { connectionId: 'deleted', provider: 'openai', model: 'removed-model' })])
    await render()
    await act(async () => { row('Saved stale').click() })

    expect(container.querySelector('[data-testid="routine-model"]')?.getAttribute('data-connection')).toBe('deleted')
    expect(container.querySelector('[data-testid="routine-model"]')?.getAttribute('data-model')).toBe('removed-model')
    expect(button('Test Run').disabled).toBe(true)
    await act(async () => { button('Save changes').click() })

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].input).toMatchObject({ connectionId: 'deleted', provider: 'openai', model: 'removed-model' })
})
