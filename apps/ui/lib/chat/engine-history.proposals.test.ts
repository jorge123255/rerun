import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { EngineMessage } from '@/lib/engine/types'
import { publicDesktopHistory, transformEngineMessages } from './engine-history'
import { desktopSkillProposalIds } from '@/lib/desktop/skill-proposal-source'

const proposalId = 'lxv-Proposal_42'
const privateMessage = 'Private model instruction: do not print this message.'
const result = { status: 'shown', proposalId, message: privateMessage, instructions: ['Private proposed rule'], token: 'private-transport-token' }

function rows(output: unknown, toolName = 'mcp__rerun__skill_propose', sessionId = 'engine-chat-a'): EngineMessage[] {
    const row = (id: string, role: EngineMessage['role'], content: unknown): EngineMessage => ({
        id, sessionId, role, contentJson: JSON.stringify(content), toolCallsJson: null, createdAt: '2026-11-04T00:00:00Z',
    })
    return [
        row('assistant-call', 'assistant', [{ type: 'tool-call', toolName, toolCallId: 'bridge-rewritten-call', input: { instruction: 'Private proposed rule', internal: 'private-input' } }]),
        row('tool-result', 'tool', [{ type: 'tool-result', toolName, toolCallId: 'bridge-rewritten-call', output }]),
    ]
}

function reopened(messages: EngineMessage[]) {
    return publicDesktopHistory(transformEngineMessages(messages, { desktopSummaries: true, preserveSourceSteps: true }))
}

describe('desktop proposal source markers across history and restart', () => {
    const shapes: [string, unknown][] = [
        ['stored JSON envelope', { type: 'json', value: result }],
        ['stored text envelope', { type: 'text', value: JSON.stringify(result) }],
        ['plain result', result],
        ['JSON result string', JSON.stringify(result)],
        ['MCP text blocks', [{ type: 'text', text: JSON.stringify(result) }]],
        ['encoded MCP text blocks', JSON.stringify([{ type: 'text', text: JSON.stringify(result) }])],
        ['enveloped MCP text blocks', { type: 'json', value: [{ type: 'text', text: JSON.stringify(result) }] }],
        ['structured MCP result', { structuredContent: result }],
    ]

    it.each(shapes)('restores only the bounded proposal marker from %s', (_name, output) => {
        const saved = rows(output)
        const untouched = JSON.stringify(saved)
        const history = reopened(saved)
        expect(history[0].id).toBe('engine-assistant-call')
        expect(history[0].parts[0]).toEqual({
            type: 'tool-mcp__rerun__skill_propose', toolName: 'mcp__rerun__skill_propose', toolCallId: 'bridge-rewritten-call',
            desktopPreview: true, state: 'output-available', input: {}, output: JSON.stringify({ status: 'shown', proposalId }),
        })
        expect(desktopSkillProposalIds(history)).toEqual(new Set([proposalId]))
        // Repeated public projection is safe and carries no hidden model instructions.
        expect(publicDesktopHistory(history)).toEqual(history)
        expect(JSON.stringify(history)).not.toMatch(/Private|private-|instructions|token/)
        expect(JSON.stringify(saved)).toBe(untouched)
    })

    it('uses the same source ID for live and saved bridged output without relying on the tool-call ID', () => {
        const live: UIMessage[] = [{ id: 'live-assistant', role: 'assistant', parts: [{
            type: 'tool-rerun__skill_propose', toolCallId: 'live-different-call', state: 'output-available', input: {}, output: JSON.stringify(result),
        }] }]
        expect(desktopSkillProposalIds(live)).toEqual(new Set([proposalId]))
        const dynamic: UIMessage[] = [{ id: 'live-dynamic', role: 'assistant', parts: [{
            type: 'dynamic-tool', toolName: 'mcp__rerun__skill_propose', toolCallId: 'dynamic-call', state: 'output-available', input: {}, output: JSON.stringify(result),
        }] }]
        expect(desktopSkillProposalIds(dynamic)).toEqual(desktopSkillProposalIds(live))
        expect(desktopSkillProposalIds(reopened(rows({ type: 'json', value: result }, 'rerun__skill_propose')))).toEqual(desktopSkillProposalIds(live))
        expect(desktopSkillProposalIds(reopened(rows(result, 'skill_propose')))).toEqual(new Set([proposalId]))
    })

    it('does not turn merged, failed or malformed results into a proposal card', () => {
        const refused = [
            null, 'not JSON', { status: 'merged', proposalId }, { status: 'failed', proposalId },
            { status: 'shown', proposalId: '' }, { status: 'shown', proposalId: 42 },
            { status: 'shown', proposalId: '../other-chat' }, { status: 'shown', proposalId: 'x'.repeat(129) },
            { status: 'shown', proposalId: 'two ids' }, { status: 'shown', proposalId: 'line\nbreak' },
            { type: 'error-json', value: result }, { type: 'error-text', value: JSON.stringify(result) },
            { type: 'json', value: { type: 'error-json', value: result } },
            { isError: true, structuredContent: result }, { type: 'json', value: { ...result, isError: true } },
            JSON.stringify({ ...result, message: 'x'.repeat(16_385) }),
        ]
        for (const output of refused) {
            const history = reopened(rows(output))
            expect(desktopSkillProposalIds(history)).toEqual(new Set())
            expect(history[0].parts[0]).toMatchObject({ input: {} })
            expect(history[0].parts[0]).not.toHaveProperty('output')
        }
    })

    it('keeps source IDs confined to the supplied chat and ignores other tools, user content and unresolved calls', () => {
        const chatA = reopened(rows(result, 'skill_propose', 'chat-a'))
        const chatB = reopened(rows({ ...result, proposalId: 'proposal-b' }, 'skill_propose', 'chat-b'))
        expect(desktopSkillProposalIds(chatA)).toEqual(new Set([proposalId]))
        expect(desktopSkillProposalIds(chatB)).toEqual(new Set(['proposal-b']))
        expect(desktopSkillProposalIds(reopened(rows(result, 'fs_read')))).toEqual(new Set())
        expect(desktopSkillProposalIds(reopened(rows(result).slice(0, 1)))).toEqual(new Set())
        expect(desktopSkillProposalIds([{ ...chatA[0], role: 'user' }])).toEqual(new Set())
    })
})
