import { expect, test, vi } from 'vitest'
import { desktopNotifyTools } from './tool'
import { desktopNotifyUserEventKey } from './contract'

const saved = vi.hoisted(() => ({ config: null as any }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => saved.config }))

const receipt = { notificationId: 'notify:a:s:r:c', eventKey: 'notify-user:a:s:r:c', attemptId: '11111111-1111-4111-8111-111111111111', agentId: 'a', sessionId: 's', runId: 'r', message: 'Review', metadata: null, status: 'shown' as const, nativeStatus: 'shown' as const, createdAt: '2026-11-06T00:00:00.000Z' }

function context() {
    const config = { name: 'Ada', enabled: true, tools: { desktopToolGrants: { notify: true } } }
    saved.config = config
    return { agent: { id: 'a', config }, sessionId: 's', runId: 'r', abortSignal: new AbortController().signal } as any
}

test('uses the original info-only nonblocking input and exact owner identity', async () => {
    const deliver = vi.fn(async () => receipt)
    const tools = desktopNotifyTools(context(), { deliver })
    const output = await (tools.notify_user as any).execute({ message: 'Review', metadata: { url: 'https://x' } }, { toolCallId: 'c', abortSignal: new AbortController().signal })
    expect(JSON.parse(output)).toEqual({ notificationId: receipt.notificationId, eventKey: receipt.eventKey, inboxStatus: 'recorded', status: 'shown', nativeStatus: 'shown', createdAt: receipt.createdAt })
    expect(output).not.toContain('https://x')
    expect(output).not.toContain('Review')
    expect(output).not.toContain(receipt.attemptId)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ notificationId: 'notify:a:s:r:c', eventKey: desktopNotifyUserEventKey({ agentId: 'a', sessionId: 's', runId: 'r', toolCallId: 'c' }), toolCallId: 'c', message: 'Review', metadata: { url: 'https://x' }, runId: 'r' }), expect.any(AbortSignal))
})

test('a missing grant hides the tool and no delivery occurs', () => {
    const deliver = vi.fn()
    const ctx = context()
    ctx.agent.config.tools.desktopToolGrants.notify = false
    expect(desktopNotifyTools(ctx, { deliver })).toEqual({})
    expect(deliver).not.toHaveBeenCalled()
})

test('unknown and failed receipts are returned once with no automatic retry', async () => {
    const deliver = vi.fn()
        .mockResolvedValueOnce({ ...receipt, status: 'unknown', nativeStatus: 'unknown' })
        .mockResolvedValueOnce({ ...receipt, status: 'failed', nativeStatus: 'unavailable' })
    const tools = desktopNotifyTools(context(), { deliver })
    const first = JSON.parse(await (tools.notify_user as any).execute({ message: 'Review' }, { toolCallId: 'c' }))
    const second = JSON.parse(await (tools.notify_user as any).execute({ message: 'Review' }, { toolCallId: 'c' }))
    expect(first.status).toBe('unknown')
    expect(first.nativeStatus).toBe('unknown')
    expect(second.status).toBe('failed')
    expect(second.nativeStatus).toBe('unavailable')
    expect(first.message).toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(2)
})

test('a run that is no longer active fails before any delivery', async () => {
    const deliver = vi.fn()
    const ctx = context()
    ctx.runId = null
    const tools = desktopNotifyTools(ctx, { deliver })
    expect(JSON.parse(await (tools.notify_user as any).execute({ message: 'Review' }, { toolCallId: 'c' }))).toMatchObject({ status: 'failed', nativeStatus: 'unavailable' })
    expect(deliver).not.toHaveBeenCalled()
})
