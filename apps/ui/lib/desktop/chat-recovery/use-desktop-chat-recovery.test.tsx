// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDesktopChatRecovery, type DesktopChatRecoveryInput } from './use-desktop-chat-recovery'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ports = () => ({ retryLastTurn: vi.fn(), continueRun: vi.fn(), stopRun: vi.fn(), newConversation: vi.fn(), switchModel: vi.fn(), reconnectProvider: vi.fn() })
function input(): DesktopChatRecoveryInput {
    return {
        scope: { agentId: 'agent-1', tabUid: 'tab-1', sessionId: 'session-1', liveSessionId: 'engine-1', runId: 'run-1', requestId: null, modelRevision: 0 },
        error: null, failedRun: null, canRetry: true, active: true, ports: ports(),
    }
}
function Probe({ value }: { value: DesktopChatRecoveryInput }) {
    const recovery = useDesktopChatRecovery(value)
    return <>
        <output>{recovery.notice?.kind ?? 'none'}</output>
        <button onClick={recovery.clear}>Clear</button>
        <button onClick={() => recovery.act('retry')}>Retry</button>
    </>
}

let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const render = (value: DesktopChatRecoveryInput) => act(async () => root.render(<Probe value={value} />))

it('renders an observed transport error after the effect and clears it without changing props', async () => {
    const value = input()
    value.error = 'overloaded'
    await render(value)
    expect(container.querySelector('output')?.textContent).toBe('overloaded')
    await act(async () => { container.querySelectorAll('button')[1].click() })
    expect(value.ports.retryLastTurn).toHaveBeenCalledOnce()
    await act(async () => { container.querySelectorAll('button')[0].click() })
    expect(container.querySelector('output')?.textContent).toBe('none')
    await act(async () => { container.querySelectorAll('button')[1].click() })
    expect(value.ports.retryLastTurn).toHaveBeenCalledOnce()
})

it('updates a mounted notice from saved run failure and removes it when that failure clears', async () => {
    const value = input()
    await render(value)
    expect(container.querySelector('output')?.textContent).toBe('none')
    await render({ ...value, failedRun: { runId: 'run-1', error: 'context window exceeded: prompt is too long' } })
    expect(container.querySelector('output')?.textContent).toBe('context_window')
    await render(value)
    expect(container.querySelector('output')?.textContent).toBe('none')
})

it('hides and fences actions for an inactive or replacement conversation', async () => {
    const value = { ...input(), error: 'overloaded' }
    await render(value)
    expect(container.querySelector('output')?.textContent).toBe('overloaded')
    await render({ ...value, active: false })
    expect(container.querySelector('output')?.textContent).toBe('none')
    await act(async () => { container.querySelectorAll('button')[1].click() })
    expect(value.ports.retryLastTurn).not.toHaveBeenCalled()
    await render({ ...value, scope: { ...value.scope, agentId: 'agent-2', sessionId: 'session-2', runId: 'run-2' }, error: null })
    expect(container.querySelector('output')?.textContent).toBe('none')
    await act(async () => { container.querySelectorAll('button')[1].click() })
    expect(value.ports.retryLastTurn).not.toHaveBeenCalled()
})
