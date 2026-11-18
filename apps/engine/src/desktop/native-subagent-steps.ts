import type { ModelMessage } from 'ai'
import { nativeSubagentName, nativeSubagentOutcome, type NativeSubagentOutcome } from '@rerun/contracts'

type Child = { name: string; outcome?: NativeSubagentOutcome }
type Chunk = { type: string; toolName?: string; toolCallId?: string; input?: unknown; output?: unknown; preliminary?: boolean; providerExecuted?: boolean }

// The SDK may stop before onStepFinish, e.g. when the owner stops a running helper.
// Retain the public receipt independently of the SDK's final assistant message.
export function nativeSubagentSteps(record: (id: string, name: string, state: 'started' | NativeSubagentOutcome) => void) {
    const children = new Map<string, Child>()
    function finish(id: string, child: Child, outcome: NativeSubagentOutcome) {
        if (child.outcome) return
        child.outcome = outcome
        record(id, child.name, outcome)
    }
    return {
        observe(chunk: Chunk) {
            const id = chunk.toolCallId
            if (!id || chunk.toolName !== 'native_subagent' || chunk.providerExecuted !== true) return
            const child = children.get(id)
            if (chunk.type === 'tool-call' && !child) {
                const name = nativeSubagentName(chunk.input)
                children.set(id, { name })
                record(id, name, 'started')
            } else if (chunk.type === 'tool-result' && child && !chunk.preliminary) {
                finish(id, child, nativeSubagentOutcome(chunk.output) ?? 'failed')
            }
        },
        settle(messages: ModelMessage[], stopped: boolean) {
            if (!children.size) return
            const calls = new Set<string>(), results = new Set<string>()
            for (const message of messages) {
                if (!Array.isArray(message.content)) continue
                for (const part of message.content) {
                    if ((part.type !== 'tool-call' && part.type !== 'tool-result') || part.toolName !== 'native_subagent') continue
                    const child = children.get(part.toolCallId)
                    if (!child) continue
                    if (part.type === 'tool-call') calls.add(part.toolCallId)
                    else {
                        results.add(part.toolCallId)
                        finish(part.toolCallId, child, nativeSubagentOutcome(part.output) ?? 'failed')
                    }
                }
            }
            for (const [toolCallId, child] of children) {
                finish(toolCallId, child, stopped ? 'cancelled' : 'failed')
                if (calls.has(toolCallId) && results.has(toolCallId)) continue
                const content: Extract<ModelMessage, { role: 'assistant' }>['content'] = []
                if (!calls.has(toolCallId)) content.push({ type: 'tool-call', toolName: 'native_subagent', toolCallId, providerExecuted: true, input: { name: child.name } })
                if (!results.has(toolCallId)) content.push({ type: 'tool-result', toolName: 'native_subagent', toolCallId, output: { type: 'json', value: { status: child.outcome! } } })
                messages.push({ role: 'assistant', content })
            }
            children.clear()
        },
    }
}
