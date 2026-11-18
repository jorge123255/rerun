import type { ModelMessage } from 'ai'
import { expect, it, vi } from 'vitest'
import { nativeSubagentSteps } from './native-subagent-steps.js'

const call = { type: 'tool-call', toolCallId: 'child-a', toolName: 'native_subagent', providerExecuted: true, input: { name: 'Claude helper', prompt: 'private task' } }

it('records each provider child once and restores a stopped child as a conversation step', () => {
    const record = vi.fn()
    const journal = nativeSubagentSteps(record)
    journal.observe({ ...call, toolCallId: 'fake', providerExecuted: false })
    journal.observe(call)
    journal.observe(call)
    journal.observe({ ...call, type: 'tool-result', output: { status: 'completed' }, preliminary: true })
    const messages: ModelMessage[] = []
    journal.settle(messages, true)
    expect(record.mock.calls).toEqual([['child-a', 'Claude helper', 'started'], ['child-a', 'Claude helper', 'cancelled']])
    expect(messages).toEqual([{ role: 'assistant', content: [
        { type: 'tool-call', toolName: call.toolName, toolCallId: call.toolCallId, providerExecuted: true, input: { name: 'Claude helper' } },
        { type: 'tool-result', toolName: call.toolName, toolCallId: call.toolCallId, output: { type: 'json', value: { status: 'cancelled' } } },
    ] }])
})

it('keeps a finished receipt when another child is interrupted and avoids duplicating SDK history', () => {
    const record = vi.fn()
    const journal = nativeSubagentSteps(record)
    journal.observe(call)
    journal.observe({ ...call, type: 'tool-result', output: { status: 'completed' } })
    journal.observe({ ...call, toolCallId: 'child-b', input: { name: 'private transcript' } })
    const messages: ModelMessage[] = [{ role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'child-a', toolName: call.toolName, input: { name: 'Claude helper' }, providerExecuted: true },
        { type: 'tool-result', toolCallId: 'child-a', toolName: call.toolName, output: { type: 'json', value: { status: 'completed' } } },
    ] }]
    const original = structuredClone(messages[0])
    journal.settle(messages, false)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(original)
    expect(JSON.stringify(messages)).not.toContain('private')
    expect(record.mock.calls.at(-1)).toEqual(['child-b', 'Sub-agent', 'failed'])
})
