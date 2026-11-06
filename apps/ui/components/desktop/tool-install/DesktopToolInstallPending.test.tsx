// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
vi.mock('./DesktopToolInstallCard', () => ({ DesktopToolInstallCard: ({ operationId, active }: { operationId: string; active: boolean }) => <div data-install={operationId} data-active={active} /> }))
vi.mock('@/lib/desktop/draft-writes', () => ({ isDesktopQuitting: () => false }))
import { DesktopToolInstallPending } from './DesktopToolInstallPending'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const ref = { operationId: 'a'.repeat(64), agentId: 'alice', sessionId: 'chat', runId: 'run', toolCallId: 'call' }
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const mount = (sessionId = 'chat', messages: UIMessage[] = [], active = true) => act(async () => root.render(<DesktopToolInstallPending agentId="alice" sessionId={sessionId} messages={messages} active={active} />))
it('recovers a missing tool-result card passively and removes its duplicate when history arrives', async () => {
    const fetcher = vi.fn(async () => Response.json({ installations: [ref], more: false })); vi.stubGlobal('fetch', fetcher)
    await mount(); expect(host.querySelectorAll('[data-install]')).toHaveLength(1)
    await mount('chat', [{ id: 'one', role: 'assistant', parts: [{ type: 'tool-tool_install', toolCallId: 'call', state: 'output-available', input: {}, output: ref }] }])
    expect(host.querySelectorAll('[data-install]')).toHaveLength(0)
    expect(fetcher.mock.calls).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('pending=1'), expect.objectContaining({ cache: 'no-store' }))
})
it('aborts an old conversation read and never mounts its delayed proposal in the new chat', async () => {
    let finish!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn((_url: string, _options: RequestInit) => delayed); vi.stubGlobal('fetch', fetcher)
    await mount(); const signal = fetcher.mock.calls[0]![1].signal!
    await mount('other-chat', [], false)
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(Response.json({ installations: [ref], more: false })) })
    expect(host.querySelectorAll('[data-install]')).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(1)
})
it('refuses a response belonging to another coworker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ installations: [{ ...ref, agentId: 'bob' }], more: false })))
    await mount(); expect(host.querySelectorAll('[data-install]')).toHaveLength(0)
    expect(host.textContent).toContain('could not be checked')
})
