import { hitlKindOf, pairSubRuns, stripBridgePrefix } from '@rerun/contracts'
import { isReasoningUIPart, isToolUIPart, type ChatStatus, type UIMessage } from 'ai'

import type { RunPhase } from '@/mocks/data'

// The line under the thread says Thinking for as long as the model reasons, as the web's loader does,
// not only until the first chunk: a reasoning part opens before any of its text arrives.
export function runPhase(status: ChatStatus, last: UIMessage | undefined): RunPhase {
    if (status === 'submitted') return 'thinking'
    if (last?.role !== 'assistant') return 'working'
    const part = last.parts.findLast(candidate => !candidate.type.startsWith('data-'))
    return part && isReasoningUIPart(part) && part.state === 'streaming' ? 'thinking' : 'working'
}

const SETTLED_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied', 'approval-requested'])

// While the message ends on a live step, its step group already shows the coworker and what it is
// doing: the run status under the thread would only repeat it.
export function stepGroupShowsActivity(last: UIMessage | undefined): boolean {
    if (last?.role !== 'assistant') return false
    const part = last.parts.findLast(candidate => !candidate.type.startsWith('data-'))
    if (!part) return false
    if (isReasoningUIPart(part)) return part.state === 'streaming'
    if (!isToolUIPart(part) || SETTLED_TOOL_STATES.has(part.state)) return false
    const toolName = stripBridgePrefix('toolName' in part ? part.toolName : part.type.slice('tool-'.length))
    if (hitlKindOf(toolName)) return false
    return !pairSubRuns(last.parts).byToolCallId.has(part.toolCallId)
}
