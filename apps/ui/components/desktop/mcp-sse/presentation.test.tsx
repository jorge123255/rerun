// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopMcpSseEditor } from './DesktopMcpSseEditor'
import { DesktopMcpSseConnection } from './DesktopMcpSseConnection'
import type { SseEditorAttempt, SseEditorDriver } from './editor-state'
import type { DesktopMcpSseRef, DesktopMcpSseSnapshot } from '@rerun/contracts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const ref: DesktopMcpSseRef = { agentId: 'owner-a', serverId: 'immutable-a', name: 'sample', expectedRevision: 'rev-a' }
const config = { name: 'sample', transport: 'sse' as const, url: 'https://example.com/sse' }
const status = (reference = ref): DesktopMcpSseSnapshot => ({ ...reference, transport: 'sse', endpointDisplay: 'https://example.com', state: 'unchecked', tools: [] })
function mount() { const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (label: string) => buttons().find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!
function driver() {
    const saved = new Map<string, SseEditorAttempt>()
    const value: SseEditorDriver = {
        journal: { read: vi.fn(async slot => saved.get(slot) ?? null), put: vi.fn(async (slot, attempt) => { saved.set(slot, attempt) }), clear: vi.fn(async slot => { saved.delete(slot) }) },
        save: vi.fn(async change => ({ requestId: change.requestId, status: 'unknown' as const })), remove: vi.fn(async (_reference, requestId) => ({ requestId, status: 'unknown' as const })),
        reconcile: vi.fn(async (_agentId, requestId) => ({ requestId, status: 'saved' as const, reference: { ...ref, expectedRevision: 'rev-saved' } })),
    }
    return value
}
test('preserves original transport order, Name/URL/Headers and read-only app-managed editor', async () => {
    const root = mount(), api = driver(), choose = vi.fn(), done = vi.fn()
    await act(async () => root.render(<DesktopMcpSseEditor agentId={ref.agentId} reference={ref} configuration={config} authentication="configured" driver={api} onBack={() => {}} onDone={done} readOnly/>))
    expect(buttons().filter(node => ['stdio', 'sse', 'http'].includes(node.textContent ?? '')).map(node => node.textContent)).toEqual(['stdio', 'sse', 'http'])
    expect(document.body.textContent).toContain('Name'); expect(document.body.textContent).toContain('URL'); expect(document.body.textContent).toContain('Headers')
    expect(document.body.textContent).toContain('managed automatically'); expect(button('Save changes')).toBeUndefined(); expect(button('Delete server')).toBeUndefined()
    expect(document.querySelector('input[type=password]')).toBeNull(); expect(api.save).not.toHaveBeenCalled()
    await act(async () => root.render(<DesktopMcpSseEditor agentId={ref.agentId} configuration={config} authentication="anonymous" driver={api} onBack={() => {}} onDone={done} onChooseTransport={choose}/>))
    await act(async () => button('http').click())
    expect(choose).toHaveBeenCalledExactlyOnceWith('http'); expect(api.save).not.toHaveBeenCalled()
})
test('unknown save survives reopening/revision change and reconciles the same attempt without auto-save', async () => {
    const root = mount(), api = driver(), done = vi.fn()
    const render = (reference = ref) => <DesktopMcpSseEditor agentId={ref.agentId} reference={reference} configuration={config} authentication="anonymous" driver={api} onBack={() => {}} onDone={done}/>
    await act(async () => root.render(render()))
    await act(async () => button('Save changes').click())
    expect(api.save).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled()
    const requestId = vi.mocked(api.save).mock.calls[0][0].requestId
    await act(async () => root.render(render({ ...ref, expectedRevision: 'rev-saved' })))
    expect(button('Reconcile settings')).toBeDefined(); expect(api.save).toHaveBeenCalledTimes(1)
    await act(async () => button('Reconcile settings').click())
    expect(api.reconcile).toHaveBeenCalledWith(ref.agentId, requestId, expect.any(AbortSignal)); expect(done).toHaveBeenCalledOnce()
})
test('stale owner reads cannot update a new coworker and mount performs no connect/probe', async () => {
    const root = mount(); let old!: (snapshot: DesktopMcpSseSnapshot) => void
    const next = { ...ref, agentId: 'owner-b', serverId: 'immutable-b' }
    const api = { read: vi.fn((reference: DesktopMcpSseRef) => reference.agentId === ref.agentId ? new Promise<DesktopMcpSseSnapshot>(resolve => { old = resolve }) : Promise.resolve(status(next))), operate: vi.fn(async () => status()) }
    await act(async () => root.render(<DesktopMcpSseConnection reference={ref} driver={api} onEdit={() => {}}/>))
    await act(async () => root.render(<DesktopMcpSseConnection reference={next} driver={api} onEdit={() => {}}/>))
    await act(async () => old({ ...status(), state: 'connected' }))
    expect(document.body.textContent).toContain('Not checked'); expect(document.body.textContent).not.toContain('Connected ·')
    expect(api.operate).not.toHaveBeenCalled()
})
test('a failed disconnect remains retryable with the same request identity', async () => {
    const root = mount(), api = { read: vi.fn(async () => status()), operate: vi.fn().mockRejectedValueOnce(new Error('unknown')).mockResolvedValue({ ...status(), state: 'disconnected' }) }
    await act(async () => root.render(<DesktopMcpSseConnection reference={ref} driver={api} onEdit={() => {}}/>))
    await act(async () => button('Disconnect').click())
    expect(button('Disconnect').disabled).toBe(false)
    await act(async () => button('Disconnect').click())
    expect(api.operate.mock.calls[0][0].requestId).toBe(api.operate.mock.calls[1][0].requestId)
})
