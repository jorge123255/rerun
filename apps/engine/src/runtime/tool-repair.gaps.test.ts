import { InvalidToolInputError, NoSuchToolError } from 'ai'
import { describe, expect, it } from 'vitest'
import { loopToolNameFor, repairToolCall } from './tool-repair.js'

const toolCall = { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'fs_read', input: JSON.stringify({ path: 'notes.md', encoding: null }) }

async function repair(error: unknown, input = toolCall.input, call: Partial<typeof toolCall> = {}, tools: Record<string, unknown> = {}) {
    return repairToolCall({ toolCall: { ...toolCall, input, ...call }, error, tools, inputSchema: () => ({}), messages: [], system: undefined } as any)
}

const loopTools = { schedule_list: {}, fs_read: {}, github_pull_request_read: {} }

describe('repairToolCall', () => {
    it('rewrites the input of a call rejected for its nulls, keeping the rest of the call', async () => {
        const error = new InvalidToolInputError({ toolName: 'fs_read', toolInput: toolCall.input, cause: new Error('Expected string, received null') })
        expect(await repair(error)).toEqual({ ...toolCall, input: JSON.stringify({ path: 'notes.md' }) })
    })

    it('gives up on an invalid input that has no null to strip', async () => {
        const input = JSON.stringify({ path: 42 })
        const error = new InvalidToolInputError({ toolName: 'fs_read', toolInput: input, cause: new Error('Expected string') })
        expect(await repair(error, input)).toBeNull()
    })

    it('leaves a call to an unknown tool alone', async () => {
        expect(await repair(new NoSuchToolError({ toolName: 'fs_read' }))).toBeNull()
    })

    it('calls the Rerun tool a model named the way Claude does', async () => {
        const call = { toolName: 'mcp__rerun__schedule_list', input: '{}' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), call.input, call, loopTools)).toEqual({ ...toolCall, ...call, toolName: 'schedule_list' })
    })

    it('calls the Rerun tool a model named the way Codex does', async () => {
        const call = { toolName: 'rerun__schedule_list', input: '{}' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), call.input, call, loopTools)).toMatchObject({ toolName: 'schedule_list' })
    })

    it('calls the connector tool a model named the way Claude does', async () => {
        const call = { toolName: 'mcp__github__pull_request_read', input: '{"pullNumber":174}' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), call.input, call, loopTools)).toMatchObject({ toolName: 'github_pull_request_read', input: call.input })
    })

    it('drops the nulls of a renamed call in the same repair', async () => {
        const call = { toolName: 'mcp__rerun__fs_read' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), toolCall.input, call, loopTools)).toEqual({ ...toolCall, toolName: 'fs_read', input: JSON.stringify({ path: 'notes.md' }) })
    })

    it('gives up on a prefixed name whose tool does not exist in this run', async () => {
        const call = { toolName: 'mcp__rerun__schedule_delete', input: '{}' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), call.input, call, loopTools)).toBeNull()
    })

    it('does not activate a disabled or unknown tool from punctuation or case drift', async () => {
        expect(loopToolNameFor('Schedule_List', loopTools as any)).toBeNull()
        expect(loopToolNameFor('schedule-list', loopTools as any)).toBeNull()
        expect(loopToolNameFor('mcp__rerun__Schedule_List', loopTools as any)).toBeNull()
        expect(await repair(new NoSuchToolError({ toolName: 'schedule-list' }), '{}', { toolName: 'schedule-list' }, loopTools)).toBeNull()
    })

    it('preserves the original toolCallId when renaming an enabled tool', async () => {
        const call = { toolCallId: 'call-repeated-9', toolName: 'mcp__rerun__schedule_list', input: '{}' }
        expect(await repair(new NoSuchToolError({ toolName: call.toolName }), call.input, call, loopTools)).toEqual({
            ...toolCall,
            ...call,
            toolName: 'schedule_list',
        })
    })
})
