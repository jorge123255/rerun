import type { DesktopOpencodeDispatch, DesktopOpencodeResult } from '@rerun/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopOpencodeAuthoritySnapshot } from './authority'
import { publishDesktopOpencode, type DesktopOpencodePorts } from './publisher'
import { memoryDesktopOpencodeStore } from './store'

const dispatch: DesktopOpencodeDispatch = { workspaceId: 1, connectionId: 'oc', connectionRevision: 'rev-1', consoleEnabled: false, modelId: 'go/deepseek-v4-pro', purpose: 'chat', runId: 'run-1', requestId: 'req-1', sessionId: 'session-1', stream: true }
const saved: DesktopOpencodeResult = { status: 'saved', message: 'OpenCode finished.', sent: true, text: 'ok' }

function snapshot(over: Partial<DesktopOpencodeAuthoritySnapshot> = {}): DesktopOpencodeAuthoritySnapshot {
    return { workspaceId: 1, owner: 'owner', connectionId: 'oc', connectionRevision: 'rev-1', apiKey: 'oc_sk_test', consoleEnabled: false, enabledModelIds: ['go/deepseek-v4-pro'], defaultModelId: 'go/deepseek-v4-pro', state: 'active', launchNonce: 'launch-1', ...over }
}

function ports(over: Partial<DesktopOpencodePorts> = {}): DesktopOpencodePorts & { execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn(async () => saved)
    return { authority: { current: async () => snapshot() }, store: memoryDesktopOpencodeStore(), execute, ...over, execute: over.execute ?? execute }
}

describe('desktop OpenCode publisher', () => {
    let bound: ReturnType<typeof ports>
    beforeEach(() => { bound = ports() })

    it('reads the catalog and checks enablement without executing', async () => {
        const view = await publishDesktopOpencode(bound, { action: 'catalog', workspaceId: 1, connectionId: 'oc', requestId: 'read-1', selectedModelId: 'go/deepseek-v4-pro' }, undefined, 'launch-1')
        expect(view).toMatchObject({ source: 'snapshot', fresh: false, selectedPreserved: true })
        const locked = await publishDesktopOpencode(bound, { action: 'enable', workspaceId: 1, connectionId: 'oc', enabledModelIds: ['console/claude-haiku-5-5'], defaultModelId: 'console/claude-haiku-5-5', consoleEnabled: false }, undefined, 'launch-1')
        expect(locked).toMatchObject({ ok: false })
        expect(bound.execute).not.toHaveBeenCalled()
    })

    it('refuses another workspace, a ChatGPT key, Console, and a replaced revision before execute', async () => {
        const other = ports({ authority: { current: async () => snapshot({ workspaceId: 2 }) } })
        expect(await publishDesktopOpencode(other, { action: 'execute', dispatch }, undefined, 'launch-1')).toMatchObject({ code: 'workspace', sent: false })
        const chatgpt = ports({ authority: { current: async () => snapshot({ apiKey: 'eyJchatgpt' }) } })
        expect(await publishDesktopOpencode(chatgpt, { action: 'execute', dispatch }, undefined, 'launch-1')).toMatchObject({ code: 'credential', sent: false })
        expect(await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, modelId: 'console/claude-haiku-5-5', requestId: 'console' } }, undefined, 'launch-1')).toMatchObject({ code: 'console', sent: false })
        expect(await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, connectionRevision: 'rev-2', requestId: 'replaced' } }, undefined, 'launch-1')).toMatchObject({ code: 'replaced', sent: false })
        expect(other.execute).not.toHaveBeenCalled()
        expect(chatgpt.execute).not.toHaveBeenCalled()
        expect(bound.execute).not.toHaveBeenCalled()
    })

    it('stores Stop before send and does not send that request again', async () => {
        const controller = new AbortController()
        let checks = 0
        const stopping = ports({ authority: { current: async () => { checks += 1; if (checks >= 2) controller.abort(); return snapshot() } } })
        const first = await publishDesktopOpencode(stopping, { action: 'execute', dispatch }, controller.signal, 'launch-1')
        expect(first).toMatchObject({ code: 'cancelled', sent: false })
        const second = await publishDesktopOpencode(stopping, { action: 'execute', dispatch }, undefined, 'launch-1')
        expect(second).toMatchObject({ code: 'cancelled', sent: false })
        expect(stopping.execute).not.toHaveBeenCalled()
    })

    it('replays a saved, partial, or unknown result and rejects a reused identity', async () => {
        const once = await publishDesktopOpencode(bound, { action: 'execute', dispatch, prompt: { messages: [{ role: 'user', content: 'hi' }] } }, undefined, 'launch-1')
        const again = await publishDesktopOpencode(bound, { action: 'execute', dispatch, prompt: { messages: [{ role: 'user', content: 'hi' }] } }, undefined, 'launch-1')
        expect(again).toEqual(once)
        expect(bound.execute).toHaveBeenCalledTimes(1)
        bound.execute.mockResolvedValueOnce({ status: 'partial', message: 'OpenCode stopped after a partial answer.', code: 'transport', sent: true, text: 'Hel' })
        const partial = await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, requestId: 'partial' } }, undefined, 'launch-1')
        expect(partial).toMatchObject({ status: 'partial', text: 'Hel' })
        expect(await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, requestId: 'partial' } }, undefined, 'launch-1')).toMatchObject({ status: 'partial' })
        bound.execute.mockRejectedValueOnce(new TypeError('fetch failed'))
        expect(await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, requestId: 'unknown' } }, undefined, 'launch-1')).toMatchObject({ status: 'unknown', sent: true })
        expect(await publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, requestId: 'unknown' } }, undefined, 'launch-1')).toMatchObject({ status: 'unknown' })
        await expect(publishDesktopOpencode(bound, { action: 'execute', dispatch: { ...dispatch, modelId: 'go/glm-5.2' } }, undefined, 'launch-1')).rejects.toThrow(/identity was reused/)
    })

    it('forgets usage on disconnect and does not execute', async () => {
        bound.refreshLimits = vi.fn(async () => [{ kind: 'weekly' as const, label: null, usedPercent: 10, resetsAt: null }])
        const reading = await publishDesktopOpencode(bound, { action: 'usage', workspaceId: 1, connectionId: 'oc', requestId: 'use-1', refresh: true }, undefined, 'launch-1')
        expect(reading).toMatchObject({ fresh: true })
        expect(await publishDesktopOpencode(bound, { action: 'disconnect', workspaceId: 1, connectionId: 'oc' }, undefined, 'launch-1')).toEqual({ ok: true })
        expect(await publishDesktopOpencode(bound, { action: 'usage', workspaceId: 1, connectionId: 'oc', requestId: 'use-2' }, undefined, 'launch-1')).toMatchObject({ windows: [], fresh: false })
        expect(bound.execute).not.toHaveBeenCalled()
    })
})
