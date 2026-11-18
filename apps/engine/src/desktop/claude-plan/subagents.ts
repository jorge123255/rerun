import type { CanUseTool, ClaudeCodeSettings } from 'ai-sdk-provider-claude-code'
import { SELF_MCP_RESERVED_NAME as BRIDGE_SERVER_NAME } from '@rerun/contracts'

const HELPER = 'rerun-helper'
const SPAWN = 'Agent'
const LIMIT = 3
const DENIED = 'This tool is not enabled for this coworker.'
const delegatedCalls = new Set(['call_agent', 'delegate_tasks'].map(name => `mcp__${BRIDGE_SERVER_NAME}__${name}`))
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

// sdk.d.ts 0.3.322: BaseHookInput.agent_id identifies the child; a bare allowedTools
// entry can skip CanUseTool, and dontAsk never prompts. PreToolUse runs before both.
export function desktopClaudeSubagents(bridgeTools: string[], signal: AbortSignal, hooks: ClaudeCodeSettings['hooks']) {
    const active = new Set<string>()
    const allowed = new Set(bridgeTools)
    const helperTools = bridgeTools.filter(name => !delegatedCalls.has(name))

    function admit(name: string, input: unknown, id: unknown, child: unknown, server: unknown, phase: 'before' | 'permission') {
        const deny = (message: string) => ({ behavior: 'deny' as const, message })
        if (signal.aborted || !isRecord(input) || typeof id !== 'string' || !id) return deny(DENIED)
        if (name !== SPAWN) {
            if (!allowed.has(name) || !isRecord(server) || server.name !== BRIDGE_SERVER_NAME || server.source !== 'sdk' || (child !== undefined && delegatedCalls.has(name))) return deny(DENIED)
            return { behavior: 'allow' as const, updatedInput: input }
        }
        if (child !== undefined
            || typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.description !== 'string'
            || Object.keys(input).some(key => !['description', 'prompt', 'subagent_type', 'run_in_background'].includes(key))
            || (input.subagent_type !== undefined && input.subagent_type !== HELPER)
            || (input.run_in_background !== undefined && input.run_in_background !== false)) {
            return deny('Only the foreground Rerun helper can be started by the parent coworker.')
        }
        if (phase === 'before') {
            if (active.has(id) || active.size >= LIMIT) return deny('This Claude helper cannot be started. At most three can run at once.')
            active.add(id)
        } else if (!active.has(id)) return deny(DENIED)
        return { behavior: 'allow' as const, updatedInput: { description: input.description, prompt: input.prompt, subagent_type: HELPER, run_in_background: false } }
    }

    const before = async (input: unknown) => {
        if (!isRecord(input) || input.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string') {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENIED } }
        }
        const result = admit(input.tool_name, input.tool_input, input.tool_use_id, input.agent_id, input.mcp_server, 'before')
        return { hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.behavior,
            ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : { permissionDecisionReason: result.message }),
        } }
    }
    const after = async (input: unknown) => {
        if (isRecord(input) && typeof input.tool_use_id === 'string' && (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') && input.tool_name === SPAWN && input.agent_id === undefined) active.delete(input.tool_use_id)
        return {}
    }
    const canUseTool: CanUseTool = async (name, input, options) => admit(name, input, options.toolUseID, options.agentID, options.mcpServer, 'permission')
    const guarded = { hooks: [before], onFailure: 'block' as const }
    return {
        tools: [SPAWN],
        // No SDK preapproved rules. Only the in-process Rerun bridge is registered.
        allowedTools: [],
        agents: { [HELPER]: {
            description: 'Delegate a bounded foreground task to a helper with this coworker’s tools.',
            prompt: 'Complete the task assigned by your parent coworker and return your result to it.',
            model: 'inherit', tools: helperTools, permissionMode: 'dontAsk', background: false,
        } },
        forwardSubagentText: false, agentProgressSummaries: false,
        canUseTool, hooks: { ...hooks, PreToolUse: [guarded], PostToolUse: [{ hooks: [after] }], PostToolUseFailure: [{ hooks: [after] }] },
    } satisfies Partial<ClaudeCodeSettings>
}

// The CLI runs the child and consumes its real result internally. This copy of its
// stdout goes to the host SDK. Preserve control requests (including child hooks),
// the parent answer and usage, but expose only the child step to Rerun's history.
export function desktopClaudeChildDisplay(nextNumber: () => number) {
    const spawns = new Map<string, number>()
    const inputBlocks = new Set<number>()
    return (raw: string): string => {
        const msg: unknown = JSON.parse(raw)
        if (!isRecord(msg)) return raw
        // Task status messages contain private descriptions, summaries, and transcript
        // paths. The provider ignores them today; only the sanitized tool step is public.
        if (msg.type === 'tool_use_summary' || msg.type === 'tool_progress' || (msg.type === 'system' && typeof msg.subtype === 'string' && (msg.subtype.startsWith('task_') || msg.subtype === 'background_tasks_changed'))) return ''
        if (msg.type !== 'assistant' && msg.type !== 'user' && msg.type !== 'stream_event') return raw
        if (msg.parent_tool_use_id != null) return ''
        if (msg.type === 'stream_event' && isRecord(msg.event)) {
            const event = msg.event
            if (event.type === 'message_start') inputBlocks.clear()
            if (typeof event.index !== 'number') return raw
            if (event.type === 'content_block_start') {
                inputBlocks.delete(event.index)
                if (isRecord(event.content_block) && (event.content_block.name === SPAWN || event.content_block.name === 'Task')) {
                    inputBlocks.add(event.index)
                    return ''
                }
            }
            if (!inputBlocks.has(event.index)) return raw
            if (event.type === 'content_block_stop') inputBlocks.delete(event.index)
            return ''
        }
        const message = msg.message
        if (!isRecord(message) || !Array.isArray(message.content)) return raw
        let changed = false
        const content = message.content.map((block: unknown) => {
            if (!isRecord(block)) return block
            if (msg.type === 'assistant' && block.type === 'tool_use' && (block.name === SPAWN || block.name === 'Task') && typeof block.id === 'string') {
                changed = true
                const number = spawns.get(block.id) ?? nextNumber()
                spawns.set(block.id, number)
                return { type: 'tool_use', id: block.id, name: 'native_subagent', input: { name: 'Claude helper ' + number } }
            }
            if (msg.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string' && spawns.has(block.tool_use_id)) {
                changed = true
                return { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error === true, content: JSON.stringify({ status: block.is_error === true ? 'failed' : 'completed' }) }
            }
            return block
        })
        if (!changed) return raw
        delete msg.tool_use_result
        return JSON.stringify({ ...msg, message: { ...message, content } }) + '\n'
    }
}
