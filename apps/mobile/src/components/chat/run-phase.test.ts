import type { UIMessage } from 'ai'

import { runPhase, stepGroupShowsActivity } from '@/components/chat/run-phase'

const assistant = (parts: UIMessage['parts']): UIMessage => ({ id: 'a', role: 'assistant', parts })

describe('run phase', () => {
    it('thinks while the message is on its way', () => {
        expect(runPhase('submitted', undefined)).toBe('thinking')
    })

    it('thinks while a reasoning part streams, even before its first word', () => {
        expect(runPhase('streaming', assistant([{ type: 'reasoning', text: '', state: 'streaming' }]))).toBe('thinking')
    })

    it('reads through the data parts that follow the reasoning', () => {
        expect(
            runPhase(
                'streaming',
                assistant([
                    { type: 'reasoning', text: '', state: 'streaming' },
                    { type: 'data-usage', data: {} },
                ])
            )
        ).toBe('thinking')
    })

    it('works once the reasoning is done or the answer is being written', () => {
        expect(runPhase('streaming', assistant([{ type: 'reasoning', text: 'Plan', state: 'done' }]))).toBe('working')
        expect(
            runPhase(
                'streaming',
                assistant([
                    { type: 'reasoning', text: 'Plan', state: 'done' },
                    { type: 'text', text: 'Hi', state: 'streaming' },
                ])
            )
        ).toBe('working')
    })

    it('works when the last message is not the assistant one', () => {
        expect(runPhase('streaming', { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hi' }] })).toBe('working')
    })
})

describe('step group shows activity', () => {
    it('holds while the step group is thinking or running a tool', () => {
        expect(stepGroupShowsActivity(assistant([{ type: 'reasoning', text: '', state: 'streaming' }]))).toBe(true)
        expect(stepGroupShowsActivity(assistant([{ type: 'dynamic-tool', toolName: 'mcp__rerun__web_search', toolCallId: 'c1', state: 'input-available', input: {} }]))).toBe(true)
    })

    it('leaves the run status when nothing in the group is live', () => {
        expect(stepGroupShowsActivity(undefined)).toBe(false)
        expect(stepGroupShowsActivity(assistant([{ type: 'reasoning', text: 'Plan', state: 'done' }]))).toBe(false)
        expect(stepGroupShowsActivity(assistant([{ type: 'text', text: 'Hi', state: 'streaming' }]))).toBe(false)
        expect(stepGroupShowsActivity(assistant([{ type: 'tool-web_search', toolCallId: 'c2', state: 'output-available', input: {}, output: {} }]))).toBe(false)
    })

    it('leaves the run status for what is drawn outside the group', () => {
        expect(stepGroupShowsActivity(assistant([{ type: 'tool-ask_user', toolCallId: 'c3', state: 'input-available', input: {} }]))).toBe(false)
        expect(
            stepGroupShowsActivity(
                assistant([
                    { type: 'tool-delegate_tasks', toolCallId: 'c4', state: 'input-available', input: {} },
                    { type: 'data-delegate', id: 'c4', data: { tasks: [{ title: 'A', status: 'running', steps: 1 }] } },
                ])
            )
        ).toBe(false)
    })
})
