// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { RunModelField } from '@/components/agent/RunModelField'
import type { DesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import type { DesktopWorkspaceRoutine } from '@rerun/contracts'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import { DesktopLocale } from '../../DesktopLocale'
import { DesktopWorkspaceRoutines } from './DesktopWorkspaceRoutines'

vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null }))
vi.mock('../../DesktopTaskNotifyField', () => ({ DesktopTaskNotifyField: () => null }))
vi.mock('@/components/agent/RunModelField', () => ({
    RunModelField: ({ value, onChange, availableGroups, disabled, labels }: ComponentProps<typeof RunModelField>) => (
        <div data-routine-model={value.model} data-routine-connection={value.connectionId}>
            {availableGroups.map(group => group.models.map(model => (
                <button key={group.connectionId + model.id} disabled={disabled} onClick={() => onChange({ connectionId: group.connectionId, model: model.id })}>
                    {group.label} {model.label}
                </button>
            )))}
            <button disabled={disabled} onClick={() => onChange({ connectionId: null, model: null })}>{labels?.coworkerDefault}</button>
        </div>
    ),
}))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url !== '/api/desktop/agents/agent-a/model') throw new Error(`Unexpected request ${url}`)
        return Response.json({
            catalog: ['A', 'B'].map(name => ({
                connectionId: 'conn-' + name.toLowerCase(), name, provider: 'openai', models: [{ id: 'gpt-exact', label: 'Exact' }],
            })),
            workspace: null, coworker: null, conversation: null,
            effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: '', available: false },
        })
    }))
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})
const routine: DesktopWorkspaceRoutine = {
    agentId: 'agent-a', slug: 'daily', name: 'Daily', description: '', body: 'Do work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision: 'v1', frequency: 'Every day at 8:00 AM', nextRunAt: null, runningSince: null, setupPending: false,
    lastRunAt: '2026-11-05T08:00:00.000Z', lastResult: { status: 'done', runId: 'run-a', chat: { agentId: 'agent-a', sessionId: 'chat-a', engineSessionId: 'engine-chat-a', tabUid: 'schedule:chat-a', title: 'Daily result', runId: 'run-a' } },
}
function client(routines: DesktopWorkspaceRoutine[] = [routine]): DesktopWorkspaceRoutinesClient {
    return {
        list: vi.fn(async () => ({ routines, canRename: true })),
        mutate: vi.fn(async () => ({ routine, chat: routine.lastResult!.chat })),
    }
}
async function mount(api = client(), onOpenChat = vi.fn(), onOpenRoutine = vi.fn(), language?: DesktopLanguage) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    const list = <DesktopWorkspaceRoutines client={api} agentNameOf={() => 'Ada'} onOpenChat={onOpenChat} onOpenRoutine={onOpenRoutine} docked className="pt-24" />
    await act(async () => root.render(language ? <DesktopLocale initial={language}>{list}</DesktopLocale> : list))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    return { root, onOpenChat, onOpenRoutine }
}
const click = async (label: string) => {
    const node = [...document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
    expect(node, `Expected visible action ${label}`).toBeDefined()
    await act(async () => {
        if (node!.getAttribute('aria-haspopup') === 'menu') {
            node!.focus()
            node!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        } else node!.click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
}

test('renders the original empty state without running anything on mount', async () => {
    const api = client([])
    await mount(api)
    expect(document.body.textContent).toContain('No routines yet')
    expect(api.mutate).not.toHaveBeenCalled()
})

test('a one-shot routine shows the saved timezone and refuses an offset-free edit', async () => {
    const api = client([{ ...routine, cron: null, runAt: '2026-12-02T14:30:00Z', nextRunAt: '2026-12-02T14:30:00Z', lastRunAt: null, timezone: 'America/Chicago' }])
    await mount(api)
    expect(document.body.textContent).toContain('8:30:00 AM CST')
    await click('Daily options'); await click('Edit')
    expect(document.body.textContent).toContain('8:30:00 AM CST')
    const field = document.querySelector<HTMLInputElement>('input[aria-label^="Run at"]')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '2026-12-02T08:30:00')
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save changes')!
    expect(save.disabled).toBe(true)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(api.mutate).not.toHaveBeenCalled()
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '2026-12-02T09:30:00-06:00')
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Save changes')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({
        action: 'edit', input: expect.objectContaining({ runAt: '2026-12-02T15:30:00.000Z', cron: null, timezone: 'America/Chicago' }),
    }))
})

test('Run now opens the exact adopted result chat and never a guessed session', async () => {
    const api = client()
    const { onOpenChat } = await mount(api)
    await click('Daily options')
    await click('Run now')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: expect.any(String) }))
    expect(onOpenChat).toHaveBeenCalledWith(routine.lastResult!.chat)
})

test('opens an older routine result from History and preserves the editor draft on Back', async () => {
    const modelFetch = globalThis.fetch
    const path = '/api/desktop/coworkers/agent-a/schedules'
    const older = { ...routine.lastResult!.chat, sessionId: 'older-chat', runId: 'older-run' }
    const open = vi.fn(async () => Response.json(older))
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url === path + '?history=daily') return Response.json([
            { id: 'run-a', status: 'done', startedAt: '2026-11-05T08:00:00.000Z' },
            { id: older.runId, status: 'error', startedAt: '2026-11-04T08:00:00.000Z' },
        ])
        if (url === path && init?.method === 'POST') {
            expect(JSON.parse(String(init.body))).toEqual({ action: 'open-run', slug: 'daily', runId: older.runId })
            return open()
        }
        return modelFetch(url, init)
    })
    const { onOpenChat } = await mount()
    await click('Daily options'); await click('Edit')
    const name = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name(), 'Unsaved draft')
    await act(async () => name().dispatchEvent(new Event('input', { bubbles: true })))
    await click('History')
    const rows = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.trim() === 'Open result chat')
    expect(rows).toHaveLength(2)
    await act(async () => rows[1].click())
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(older)
    await click('Back')
    expect(name().value).toBe('Unsaved draft')
})

test('confirms deletion of the reviewed revision and leaves the sibling routine visible', async () => {
    const other = { ...routine, agentId: 'agent-b', name: 'Sibling task' }
    const api = client([routine, other])
    const modelFetch = globalThis.fetch
    const remove = vi.fn(async () => {
        vi.mocked(api.list).mockResolvedValue({ routines: [other], canRename: true })
        return Response.json({ deleted: routine.slug })
    })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/coworkers/agent-a/schedules' && init?.method === 'DELETE') {
            expect(JSON.parse(String(init.body))).toEqual({ slug: routine.slug, expectedRevision: routine.revision })
            return remove()
        }
        return modelFetch(url, init)
    })
    await mount(api)
    await click('Daily options'); await click('Edit'); await click('Delete task')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Delete Daily?')
    await click('Cancel')
    expect(remove).not.toHaveBeenCalled()
    await click('Delete task')
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Delete task')
    expect(confirm).toBeDefined()
    await act(async () => confirm!.click())
    expect(remove).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Sibling task')
    expect(document.querySelector('[aria-label="Daily options"]')).toBeNull()
})

test('a routine without a result disables its result link instead of opening the editor', async () => {
    const { lastResult: _lastResult, ...unrun } = routine
    const { onOpenChat, onOpenRoutine } = await mount(client([unrun]))
    await click('Daily options')
    const result = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Open result chat')!
    expect(result.getAttribute('aria-disabled')).toBe('true')
    await act(async () => result.click())
    expect(onOpenChat).not.toHaveBeenCalled()
    expect(onOpenRoutine).not.toHaveBeenCalled()
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull()
})

test('pause failure restores the previous enabled state and keeps the held row visible', async () => {
    const api = client()
    api.mutate = vi.fn(async () => { throw new Error('revision changed') })
    await mount(api)
    await click('Pause Daily')
    expect(document.body.textContent).toContain('Daily')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'toggle', enabled: false, expectedRevision: 'v1' }))
    expect(document.querySelector('[aria-label="Pause Daily"]')).toBeTruthy()
})

test('polling preserves an edited draft and offers refresh choices before saving', async () => {
    const api = client()
    const { root } = await mount(api)
    await click('Daily options')
    await click('Edit')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My edited name')
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
    api.list = vi.fn(async () => ({ routines: [{ ...routine, revision: 'v2', name: 'Latest server name' }], canRename: true }))
    await act(async () => root.render(<DesktopWorkspaceRoutines client={api} agentNameOf={() => 'Ada'} onOpenChat={vi.fn()} onOpenRoutine={vi.fn()} docked refreshKey={2} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    expect(input.value).toBe('My edited name')
    expect(document.body.textContent).toContain('This routine changed while you were editing.')
    await click('Refresh from latest')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe('Latest server name')
})


test('each acknowledged human Run now gets a new occurrence identity', async () => {
    const api = client(); await mount(api)
    await click('Daily options'); await click('Run now')
    const first = vi.mocked(api.mutate).mock.calls[0][0].requestId
    await click('Daily options'); await click('Run now')
    expect(vi.mocked(api.mutate).mock.calls[1][0].requestId).not.toBe(first)
})

test('unknown Run now acknowledgement retries the same occurrence identity', async () => {
    const api = client(); api.mutate = vi.fn().mockRejectedValueOnce(new Error('Lost acknowledgement')).mockResolvedValue({ routine, chat: routine.lastResult!.chat })
    await mount(api); await click('Daily options'); await click('Run now')
    const first = vi.mocked(api.mutate).mock.calls[0][0].requestId
    await click('Daily options'); await click('Run now')
    expect(vi.mocked(api.mutate).mock.calls[1][0].requestId).toBe(first)
})

test('Keep my draft adopts the new reviewed revision without replacing text', async () => {
    const api = client(); const { root } = await mount(api)
    await click('Daily options'); await click('Edit')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My draft')
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
    api.list = vi.fn<DesktopWorkspaceRoutinesClient['list']>(async () => ({
        routines: [{ ...routine, revision: 'v2', name: 'Changed outside', connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }],
        canRename: true,
    }))
    await act(async () => root.render(<DesktopWorkspaceRoutines client={api} agentNameOf={() => 'Ada'} onOpenChat={vi.fn()} docked refreshKey={2} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    await click('Keep my draft')
    expect(document.querySelector('[data-routine-connection="conn-b"]')).toBeTruthy()
    await click('Save changes')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'edit', expectedRevision: 'v2', input: expect.objectContaining({ name: 'My draft' }) }))
    expect(vi.mocked(api.mutate).mock.calls[0][0]).not.toHaveProperty('input.modelOverride')
})

test('selects by connection when two models share an ID and requires saving before running', async () => {
    const api = client([{ ...routine, connectionId: 'conn-a', provider: 'openai', model: 'gpt-exact' }])
    await mount(api)
    await click('Daily options'); await click('Edit')
    expect(document.querySelector('[data-routine-connection="conn-a"]')).toBeTruthy()
    await click('B Exact')
    await click('Run now')
    expect(api.mutate).not.toHaveBeenCalled()
    await click('Save changes')
    expect(vi.mocked(api.mutate).mock.calls[0][0]).toHaveProperty('input.modelOverride', { connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' })
})

test('preserves an unavailable model on unrelated saves and allows explicitly clearing it', async () => {
    const unavailable = { ...routine, connectionId: 'removed', provider: 'openai', model: 'old-model' } as const
    const api = client([unavailable])
    api.mutate = vi.fn(async () => ({ routine: unavailable }))
    await mount(api)
    await click('Daily options'); await click('Edit')
    expect(document.body.textContent).toContain('The saved model is unavailable')
    await click('Save changes')
    expect(vi.mocked(api.mutate).mock.calls[0][0]).not.toHaveProperty('input.modelOverride')
    await click('Daily options'); await click('Edit')
    await click('Coworker default')
    await click('Save changes')
    expect(vi.mocked(api.mutate).mock.calls[1][0]).toHaveProperty('input.modelOverride', null)
})

test('French editing and running keep the reviewed revision, raw schedule and exact result chat', async () => {
    const api = client()
    const language: DesktopLanguage = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) }
    const { onOpenChat } = await mount(api, vi.fn(), vi.fn(), language)
    expect(document.body.textContent).toContain('Tous les jours à')
    expect(document.querySelector('[aria-label="Mettre en pause Daily"]')).toBeTruthy()
    await click('Options de Daily')
    await click('Modifier')
    expect(document.querySelector('.pt-24')?.textContent).toContain('Modifier la tâche')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Nom"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Résumé quotidien')
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Expression cron"]')?.value).toBe(routine.cron)
    await click('Enregistrer')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({
        action: 'edit', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision,
        input: { name: 'Résumé quotidien', description: routine.description, body: routine.body, enabled: true, timezone: 'UTC', cron: routine.cron, runAt: null },
    }))
    await click('Options de Daily')
    await click('Lancer maintenant')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1' }))
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(routine.lastResult!.chat)
})
