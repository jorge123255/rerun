import { expect, it } from 'vitest'
import { publicDesktopHistory, transformEngineMessages, type HistoryMessage } from '@/lib/chat/engine-history'
import { desktopToolInstallReferenceOf } from './tool-install-reference'
const reference = { operationId: 'a'.repeat(64), agentId: 'alice', sessionId: 'chat', runId: 'run', toolCallId: 'call' }
const snapshot = { ...reference, proposalRevision: '1', revision: '1', status: 'pending-approval', packages: [{ package: 'example@1.0.0', status: 'pending' }], guestId: 'b'.repeat(64), availability: 'isolated-guest-only', output: 'x'.repeat(16000), createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
it('retains only immutable public source references in chat history, with exact tool-call identity', () => {
    expect(desktopToolInstallReferenceOf(snapshot)).toEqual(reference)
    const row: HistoryMessage = { id: 'engine-one', role: 'assistant', parts: [{ type: 'tool-tool_install', toolName: 'tool_install', toolCallId: 'call', state: 'output-available', input: { packages: ['example@1.0.0'] }, output: snapshot }] }
    const result = publicDesktopHistory([row])[0]!.parts[0]!
    expect('output' in result && JSON.parse(String(result.output))).toEqual(reference)
    expect(JSON.stringify(result)).not.toContain('guestId'); expect(JSON.stringify(result)).not.toContain('16000')
    const wrong = publicDesktopHistory([{ ...row, parts: [{ ...(row.parts[0] as Extract<HistoryMessage['parts'][number], { toolName: string }>), toolCallId: 'other-call' }] }])[0]!.parts[0]!
    expect('output' in wrong).toBe(false)
})
it('keeps a reference before long tool output is preview-trimmed during engine hydration', () => {
    const source = [
        { id: 'one', sessionId: 'chat', role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolCallId: 'call', toolName: 'tool_install', input: {} }]), toolCallsJson: null, createdAt: 'now' },
        { id: 'two', sessionId: 'chat', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'call', toolName: 'tool_install', output: { type: 'json', value: snapshot } }]), toolCallsJson: null, createdAt: 'now' },
    ] as Parameters<typeof transformEngineMessages>[0]
    const history = publicDesktopHistory(transformEngineMessages(source))
    const part = history.flatMap(row => row.parts).find(part => 'toolName' in part)
    expect(part && 'output' in part && JSON.parse(String(part.output))).toEqual(reference)
})
