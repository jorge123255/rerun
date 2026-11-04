import { describe, expect, it } from 'vitest'
import { desktopQuestionInput, findDesktopQuestion } from '@rerun/contracts'

const input = { questions: [{ question: 'Which color?', options: ['Blue', 'Green'], multiple: true }] }
const row = (id: string, role: string, content: unknown) => ({ id, role, contentJson: JSON.stringify(content), toolCallsJson: null })
const call = (toolName = 'ask_user', raw: unknown = input) => row('ask', 'assistant', [{ type: 'tool-call', toolName, toolCallId: 'call', input: raw }])
const result = (output: unknown = { type: 'json', value: { status: 'delivered' } }) => row('result', 'tool', [{ type: 'tool-result', toolCallId: 'call', toolName: 'ask_user', output }])

describe('saved desktop questions', () => {
    it('uses the original questions protocol and stable source identity through bridge names and a closing explanation', () => {
        const question = findDesktopQuestion([row('user', 'user', 'Please ask'), call('mcp__rerun__ask_user', JSON.stringify(input)), result(), row('explain', 'assistant', 'Choose the color I will use.')])
        expect(question).toEqual({ sourceMessageId: 'ask', toolCallId: 'call', questions: input.questions, fingerprint: JSON.stringify(input.questions) })
    })

    it('accepts legacy calls and the Codex MCP delivered envelope', () => {
        const legacy = { ...row('ask', 'assistant', 'Choose a color.'), toolCallsJson: JSON.stringify([{ id: 'call', name: 'rerun__ask_user', args: { question: 'Which color?', suggestions: ['Blue', 'Green'] } }]) }
        expect(findDesktopQuestion([legacy, result({ type: 'json', value: { content: [{ type: 'text', text: '{"status":"delivered"}' }], structuredContent: null } })])?.questions)
            .toEqual([{ question: 'Which color?', options: ['Blue', 'Green'], multiple: false }])
    })

    it('requires a successful delivered result and never resurrects a question after a later user message', () => {
        expect(findDesktopQuestion([call()])).toBeNull()
        expect(findDesktopQuestion([call(), result({ type: 'error-text', value: 'Rejected' })])).toBeNull()
        expect(findDesktopQuestion([call(), result({ isError: true, status: 'delivered' })])).toBeNull()
        expect(findDesktopQuestion([call(), result(), row('answer', 'user', 'Blue')])).toBeNull()
        expect(findDesktopQuestion([call(), result(), row('answer', 'user', 'Blue'), row('failed', 'assistant', 'Failed')])).toBeNull()
    })

    it('does not confuse a reused tool ID or a later ordinary tool with the unanswered question', () => {
        expect(findDesktopQuestion([call(), result(), call('fs_read')])).toBeNull()
        expect(findDesktopQuestion([call(), result(), call()])).toBeNull()
        expect(findDesktopQuestion([call(), result(), call('skill_propose')])?.toolCallId).toBe('call')
    })

    it('rejects malformed or oversized question choices without silently changing the offered values', () => {
        expect(desktopQuestionInput({ questions: [{ question: 'Which?', options: [17] }] })).toBeNull()
        expect(desktopQuestionInput({ questions: [{ question: 'Which?', options: ['x'.repeat(501)] }] })).toBeNull()
        expect(desktopQuestionInput({ questions: [{ question: 'x'.repeat(4001) }] })).toBeNull()
        expect(desktopQuestionInput({ questions: Array.from({ length: 33 }, () => ({ question: 'Which?' })) })).toBeNull()
        expect(desktopQuestionInput({ questions: JSON.stringify([{ question: 'Which?', options: null }]) }))
            .toEqual({ questions: [{ question: 'Which?', options: [], multiple: false }] })
    })
})
