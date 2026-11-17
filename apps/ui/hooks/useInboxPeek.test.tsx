// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Chief of Staff cases of upstream's test are left out: its conversations are not read this way here.
const mocks = vi.hoisted(() => ({ peekPendingRequestAction: vi.fn(), sendSessionMessage: vi.fn() }))
vi.mock('@/app/api/_actions/session.actions', () => ({ peekPendingRequestAction: mocks.peekPendingRequestAction }))
vi.mock('@/lib/chat/send-session-message', () => ({ sendSessionMessage: mocks.sendSessionMessage }))
vi.mock('@/lib/notifications/open-conversation', () => ({ resolveSessionId: async () => null }))
vi.mock('@/hooks/useAgentModel', () => ({ useAgentModel: () => ({ selection: {} }) }))

const { useInboxPeek } = await import('./useInboxPeek')

type Hook = ReturnType<typeof useInboxPeek>

const approvalPeek = (toolCallId = 'call-1') => ({ pending: { kind: 'approval', toolCallId, input: { approvals: [{ action: 'Send the weekly report' }] } }, ask: 'Ready to send.', before: null })

let container: HTMLDivElement
let root: Root
let seen: Hook

function Probe({ agentId, enabled, revision, onRender }: { agentId: string; enabled: boolean; revision?: string; onRender: (hook: Hook) => void }) {
    onRender(useInboxPeek({ agentId, sessionId: 'session-1', engineSessionId: null }, enabled, revision))
    return null
}

async function render(agentId: string, enabled = true, revision?: string) {
    await act(async () => root.render(createElement(Probe, { agentId, enabled, revision, onRender: hook => (seen = hook) })))
}

beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    vi.clearAllMocks()
})

describe('useInboxPeek', () => {
    it('reads nothing while held off', async () => {
        await render('closer', false)
        expect(seen.peek.state).toBe('loading')
        expect(mocks.peekPendingRequestAction).not.toHaveBeenCalled()
    })

    it("reads a coworker's thread through the session action", async () => {
        mocks.peekPendingRequestAction.mockResolvedValue(approvalPeek())
        await render('closer')
        expect(mocks.peekPendingRequestAction).toHaveBeenCalledWith('session-1')
        expect(seen.peek.state).toBe('ready')
    })

    it('reads again when the conversation has moved, even if it never stopped waiting', async () => {
        mocks.peekPendingRequestAction.mockResolvedValueOnce(approvalPeek('call-1')).mockResolvedValueOnce(approvalPeek('call-2'))
        await render('closer', true, '2026-11-17T10:00:00Z')
        expect(seen.peek).toMatchObject({ peek: { pending: { toolCallId: 'call-1' } } })

        await render('closer', true, '2026-11-17T10:00:00Z')
        expect(mocks.peekPendingRequestAction).toHaveBeenCalledTimes(1)

        await render('closer', true, '2026-11-17T10:05:00Z')
        expect(mocks.peekPendingRequestAction).toHaveBeenCalledTimes(2)
        expect(seen.peek).toMatchObject({ peek: { pending: { toolCallId: 'call-2' } } })
    })
})
