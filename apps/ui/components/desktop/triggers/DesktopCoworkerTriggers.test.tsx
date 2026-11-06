// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopCoworkerTriggers } from './DesktopCoworkerTriggers'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => children }))
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/desktop/triggers', async () => ({ ...await vi.importActual<typeof import('@/lib/desktop/triggers')>('@/lib/desktop/triggers'), listDesktopTriggers: mocks.list, getDesktopTrigger: mocks.get, createDesktopTrigger: mocks.create, updateDesktopTrigger: vi.fn(), rotateDesktopTrigger: vi.fn(), deleteDesktopTrigger: vi.fn(), listDesktopTriggerHistory: mocks.history }))
let root: Root | undefined, container: HTMLDivElement
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.history.mockResolvedValue([]); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
async function render(agentId: string) { await act(async () => { root!.render(<DesktopCoworkerTriggers agentId={agentId} onOpenSession={() => {}} />) }) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text); expect(button).toBeTruthy(); await act(async () => button!.click()) }
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
const item = (name: string) => ({ slug: name.toLowerCase(), name, description: '', enabled: true, methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: 'x', createdAt: 't', revision: 'r1' })
describe('DesktopCoworkerTriggers', () => {
    it('keeps the original empty state and preserves a failed save draft', async () => {
        await render('a1'); expect(container.textContent).toContain('No triggers yet')
        await click('New'); expect(container.textContent).toContain('New trigger')
        const name = container.querySelector<HTMLInputElement>('input[placeholder="GitHub push"]')!, prompt = container.querySelector<HTMLTextAreaElement>('textarea')!
        expect(name).toBeTruthy(); expect(prompt).toBeTruthy()
        await fill(name, 'GitHub push'); await fill(prompt, 'Review the payload')
        mocks.create.mockRejectedValueOnce(new Error('offline'))
        await click('Create trigger')
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline')
        expect(name.value).toBe('GitHub push'); expect(prompt.value).toBe('Review the payload')
    })
    it('ignores a previous coworker’s late list while retaining the new coworker’s result', async () => {
        let resolveList!: (value: unknown) => void
        mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve }))
        await render('a1')
        mocks.list.mockResolvedValueOnce([item('Other')])
        await render('a2')
        await act(async () => resolveList([item('Stale')]))
        expect(container.textContent).toContain('Other'); expect(container.textContent).not.toContain('Stale')
    })
    it('shows a waiting webhook as Needs input in history, not as a still-running reply', async () => {
        mocks.list.mockResolvedValue([item('Hook')]); mocks.get.mockResolvedValue(item('Hook'))
        mocks.history.mockResolvedValue([{ eventId: 'waiting', slug: 'hook', triggerName: 'Hook', status: 'needs-input',
            receivedAt: '2026-11-06T00:00:00.000Z', finishedAt: null, localSessionId: 'waiting-chat', runId: 'waiting-run', error: null, capturedPayload: true, liveOnly: false }])
        await render('a1')
        const row = [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === 'Hook')
        expect(row).toBeTruthy()
        await act(async () => row!.click())
        await click('History')
        expect(container.textContent).toContain('Needs input')
        expect(container.textContent).not.toMatch(/running/i)
    })
})
