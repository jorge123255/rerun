// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerCallsClient, type DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'
import { DesktopCoworkerCallBlock } from './DesktopCoworkerCallBlock'

vi.mock('@/hooks/useToolDisplay', () => ({ useToolDisplay: () => (toolName: string) => ({ label: toolName, iconProps: { icon: () => null } }) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const snapshot = (status: DesktopCoworkerCallSnapshot['status'] = 'running'): DesktopCoworkerCallSnapshot => ({
    callId: 'call-1', revision: 'revision-1', parentAgentId: 'parent-agent', parentSessionId: 'parent-chat', parentRunId: 'parent-run', toolCallId: 'tool-call-1',
    targetAgentId: 'target-agent', targetSessionId: 'target-chat', targetName: 'Ada', wait: true, status,
    createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z',
    progress: { steps: 2, toolCalls: 1, failures: 0, preview: status === 'error' ? 'Provider failed.' : 'Finished the research.', calls: [{ tool: 'web_fetch', status: 'completed' }] },
})

async function withBlock(element: ReactNode, action: () => Promise<void>) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(element))
        await action()
    } finally { await act(async () => root.unmount()) }
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
const click = async (target: HTMLButtonElement) => { await act(async () => { target.click() }) }

test('uses the original live call block and opens the exact fresh target chat', async () => {
    const call = snapshot()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ calls: [call] })))
    const onOpenTarget = vi.fn(async () => {})
    const client = createDesktopCoworkerCallsClient(call.parentAgentId, call.parentSessionId)
    await withBlock(<DesktopCoworkerCallBlock client={client} call={call} onOpenTarget={onOpenTarget} />, async () => {
        expect(document.body.textContent).toContain('Calling Ada')
        expect(document.body.textContent).toContain('1 call')
        await click(button('Open chat')!)
        expect(onOpenTarget).toHaveBeenCalledExactlyOnceWith({ agentId: 'target-agent', sessionId: 'target-chat' })
    })
    client.dispose()
})

test('makes the waiting-human state and its target chat explicit', async () => {
    const call = snapshot('waiting-human')
    const client = createDesktopCoworkerCallsClient(call.parentAgentId, call.parentSessionId)
    await withBlock(<DesktopCoworkerCallBlock client={client} call={call} onOpenTarget={async () => {}} />, async () => {
        expect(document.body.textContent).toContain('Waiting for you in Ada’s chat.')
        expect(button('Open chat')).toBeDefined()
    })
    client.dispose()
})

test('keeps completed, error, cancelled and interrupted outcomes truthful after restoration', async () => {
    for (const [status, headline, detail] of [
        ['completed', 'Ada answered', 'Finished the research.'],
        ['error', 'Ada failed', 'Provider failed.'],
        ['cancelled', 'Ada failed', 'Call cancelled.'],
        ['interrupted', 'Ada failed', 'Call interrupted.'],
    ] as const) {
        const call = snapshot(status)
        const client = createDesktopCoworkerCallsClient(call.parentAgentId, call.parentSessionId)
        await withBlock(<DesktopCoworkerCallBlock client={client} call={call} />, async () => {
            expect(document.body.textContent).toContain(headline)
            const settledRow = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(headline))!
            await click(settledRow)
            expect(document.body.textContent).toContain(detail)
            expect(document.body.textContent).not.toContain('Calling Ada')
            if (status === 'cancelled' || status === 'interrupted') expect(document.body.textContent).not.toContain('Ada answered')
            expect(button('Stop this task')).toBeUndefined()
        })
        client.dispose()
        document.body.innerHTML = ''
    }
})

test('a failed Stop stays retryable and a confirmed Stop returns the exact revised snapshot', async () => {
    const call = snapshot()
    const stopped = { ...call, revision: 'revision-2', status: 'cancelled' as const }
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Stop was not acknowledged.' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ call: stopped }))
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    const client = createDesktopCoworkerCallsClient(call.parentAgentId, call.parentSessionId)
    await withBlock(<DesktopCoworkerCallBlock client={client} call={call} onChange={onChange} />, async () => {
        await click(button('Stop this task')!)
        expect(document.body.textContent).toContain('Stop was not acknowledged.')
        expect(button('Stop this task')!.disabled).toBe(false)
        await click(button('Stop this task')!)
        expect(onChange).toHaveBeenCalledExactlyOnceWith(stopped)
        expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)))
    })
    client.dispose()
})
