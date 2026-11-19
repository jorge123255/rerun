// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopForemanFilePermissions } from './DesktopForemanFilePermissions'

const chat = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const launchNonce = '11111111-1111-4111-8111-111111111111'
const grants = { foremanAgentFilesRead: false, foremanAgentFilesWrite: false, workRegister: true, skills: true }
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals()
})

it('switches the Chief of Staff skills off with the shown grants as the expected state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const patches: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            patches.push(body)
            return Response.json({ workspaceId: '1', launchNonce, grants: { ...grants, skills: body.enabled } })
        }
        return Response.json({ workspaceId: '1', launchNonce, grants })
    }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(<DesktopForemanFilePermissions chat={chat} open onOpenChange={() => {}} />) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="Suggest and use skills"]')
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle()!.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(patches).toEqual([{ chat, launchNonce, expectedGrants: grants, id: 'skills', enabled: false }])
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
})
