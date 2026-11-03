// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerTools } from './DesktopCoworkerTools'
import type { CoworkerToolRow } from '@/lib/desktop/coworker-tools'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('grants only the selected coworker, rolls back a failed revoke, and reloads the saved switch', async () => {
    const permissions = new Map<string, boolean>()
    let failWrite = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'PATCH') {
            if (failWrite) return Response.json({ error: 'Try again.' }, { status: 503 })
            const { group, id, enabled } = JSON.parse(String(init.body))
            permissions.set(url + '/' + group + '/' + id, enabled)
        }
        const row = (group: string, id: string, available = true): CoworkerToolRow => ({
            id, label: group === 'rerun' ? 'Read workspace files' : 'Run commands', description: 'This coworker', tools: ['fs_read'],
            enabled: permissions.get(url + '/' + group + '/' + id) ?? false, available,
            ...(!available && { unavailableReason: 'Workspace shell unavailable.' }),
        })
        return Response.json({ rerun: [row('rerun', 'workspaceRead')], codex: [row('codex', 'shell', false)] })
    })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (id: string) => act(async () => root.render(<DesktopCoworkerTools key={id} agent={{ id, name: id } as DesktopAgentView} />))
    const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === name)!
    const click = (el: HTMLElement) => act(async () => el.click())
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!
    try {
        await render('first'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('false')
        await click(toggle())
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        failWrite = true; await click(toggle())
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Try again.')
        await click(button('Done')); await render('second'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('false')
        await click(button('Done')); await render('first'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        expect(Array.from(permissions.keys())).toEqual(['/api/desktop/agents/first/tools/rerun/workspaceRead'])
        expect(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1].disabled).toBe(true)
        expect(document.body.textContent).toContain('Workspace shell unavailable.')
    } finally { await act(async () => root.unmount()) }
})
