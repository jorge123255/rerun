import { describe, expect, it } from 'vitest'
import { phoneChiefCards, phoneChiefConversations, phoneChiefInIntake, phoneChiefMessages } from './phone-chief'

// What a paired phone is handed of the Chief of Staff: words, never anything that settles a card.

const plan = {
    title: 'Support desk',
    items: [
        { kind: 'agent', name: 'Ava', role: 'Answers tickets', instructions: 'Never reveal this', model: { connectionId: 'c1', model: 'm1' } },
        { kind: 'template', templateId: 'tpl-newsletter', title: 'Newsletter', focus: 'Weekly issue' },
    ],
}

describe('the cards that change things', () => {
    it('are the words of the plan as last shown, and nothing that names it to the Mac', () => {
        const cards = phoneChiefCards({
            revisions: [{ revisionId: 'rev-1', state: 'shown', plan } as never],
            currentRevisionId: 'rev-1', teamChanges: null, starter: null, messageCount: 2,
        })
        expect(cards).toEqual([{ kind: 'plan', title: 'Support desk', lines: ['Ava: Answers tickets', 'Newsletter: Weekly issue'] }])
        const wire = JSON.stringify(cards)
        for (const hidden of ['rev-1', 'Never reveal this', 'c1', 'tpl-newsletter']) expect(wire).not.toContain(hidden)
    })

    it('leave out a plan that was confirmed, dismissed or replaced', () => {
        for (const state of ['confirmed', 'dismissed', 'superseded']) {
            expect(phoneChiefCards({ revisions: [{ revisionId: 'rev-1', state, plan } as never], currentRevisionId: 'rev-1', teamChanges: null, starter: null, messageCount: 2 })).toEqual([])
        }
        expect(phoneChiefCards({ revisions: [{ revisionId: 'rev-1', state: 'shown', plan } as never], currentRevisionId: 'rev-2', teamChanges: null, starter: null, messageCount: 2 })).toEqual([])
    })

    it('projects complete setup words and chat shortcuts without the approval binding', () => {
        const reply = 'Line one\n' + 'use this workspace '.repeat(48)
        const setup = { sessionId: 'qa-session', stepId: 'private-step', revision: 'private-revision', question: 'What workspace?', text: reply }
        const teamChanges = { summary: 'Set up QA', state: 'shown', changes: [
            { label: 'Reply to Ada', action: 'reply_setup', agentId: 'ada', coworker: 'Ada', setupReply: setup },
            { label: 'Start Bo', action: 'start_setup', agentId: 'bo', coworker: 'Bo' },
            { label: 'Give Kit a permission', action: 'allow', agentId: 'kit', coworker: 'Kit' },
        ] } as never
        const [card] = phoneChiefCards({ revisions: [], currentRevisionId: null, teamChanges, starter: null, messageCount: 1 })
        expect(card.setupTargets).toEqual([
            { agentId: 'ada', coworker: 'Ada', sessionId: 'qa-session', reply, question: 'What workspace?' },
            { agentId: 'bo', coworker: 'Bo', sessionId: null },
        ])
        for (const hidden of ['private-step', 'private-revision', 'kit']) expect(JSON.stringify(card.setupTargets)).not.toContain(hidden)
    })

    it('show team changes as their labels and cautions, held back as the Mac holds them', () => {
        const teamChanges = { summary: 'Two changes', state: 'shown', changes: [{ label: 'Rename Bo to Support', caution: 'Bo loses its routines' }, { label: 'Retire Ada' }] } as never
        expect(phoneChiefCards({ revisions: [], currentRevisionId: null, teamChanges, starter: null, messageCount: 3 })).toEqual([
            { kind: 'team-changes', title: 'Two changes', lines: ['Rename Bo to Support — Bo loses its routines', 'Retire Ada'] },
        ])
        // Not before anything was said, nor while a starter pack still waits.
        expect(phoneChiefCards({ revisions: [], currentRevisionId: null, teamChanges, starter: null, messageCount: 0 })).toEqual([])
        const starter = { cards: [{ title: 'Inbox triage' }], decision: null }
        expect(phoneChiefCards({ revisions: [], currentRevisionId: null, teamChanges, starter, messageCount: 3 })).toEqual([{ kind: 'starter', title: '', lines: ['Inbox triage'] }])
        expect(phoneChiefCards({ revisions: [], currentRevisionId: null, teamChanges: null, starter: { ...starter, decision: { settled: true } }, messageCount: 3 })).toEqual([])
    })
})

describe('the first-run company questions', () => {
    it('follow the Mac panel: General is in them until they are finished, when nothing was said yet or answers were saved', () => {
        expect(phoneChiefInIntake({ finished: false, savedProgress: false, messageCount: 0 })).toBe(true)
        expect(phoneChiefInIntake({ finished: false, savedProgress: true, messageCount: 4 })).toBe(true)
        // Someone wrote to it on the Mac instead of answering: the conversation is open.
        expect(phoneChiefInIntake({ finished: false, savedProgress: false, messageCount: 1 })).toBe(false)
        expect(phoneChiefInIntake({ finished: true, savedProgress: true, messageCount: 0 })).toBe(false)
    })
})

describe('the messages', () => {
    it('are their text alone: no tool call, reasoning, attachment or source', () => {
        const messages = phoneChiefMessages([
            { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Plan the week' }, { type: 'file', url: 'file:///secret.pdf' }], metadata: { createdAt: '2026-11-17T10:00:00.000Z' } },
            { id: 'a1', role: 'assistant', parts: [{ type: 'reasoning', text: 'internal thoughts' }, { type: 'tool-show_plan', toolCallId: 'call-1', input: { instructions: 'secret' } }, { type: 'text', text: 'Here is a plan.' }, { type: 'text', text: 'Confirm it on the Mac.' }] },
            { id: 'a2', role: 'assistant', parts: [{ type: 'tool-search_docs', toolCallId: 'call-2' }] },
        ])
        expect(messages).toEqual([
            { id: 'u1', role: 'user', createdAt: '2026-11-17T10:00:00.000Z', content: { type: 'text', text: 'Plan the week' } },
            { id: 'a1', role: 'assistant', content: { type: 'text', text: 'Here is a plan.\nConfirm it on the Mac.' } },
        ])
        for (const hidden of ['secret', 'internal thoughts', 'call-1', 'call-2']) expect(JSON.stringify(messages)).not.toContain(hidden)
    })
})

describe('the conversations', () => {
    it('are the ones someone wrote in, General first as the Mac lists them', () => {
        expect(phoneChiefConversations([
            { chat: { chatId: 'fmc_1' }, title: null, home: true, updatedAt: '2026-11-17T10:05:00.000Z', startedAt: '2026-11-17T10:00:00.000Z' },
            { chat: { chatId: 'fmc_2' }, title: 'Launch plan', home: false, updatedAt: '2026-11-17T11:00:00.000Z' },
            { chat: { chatId: 'fmc_3' }, title: null, home: false },
        ])).toEqual([
            { id: 'fmc_1', title: null, kind: 'general', createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:05:00.000Z' },
            { id: 'fmc_2', title: 'Launch plan', kind: 'thread', createdAt: '2026-11-17T11:00:00.000Z', updatedAt: '2026-11-17T11:00:00.000Z' },
        ])
    })
})

it('hands off only an owner-matched inspection destination from the original assistant message', () => {
    const part = { type: 'dynamic-tool', toolName: 'inspect_coworker_setup', desktopPreview: true, state: 'output-available',
        output: { state: 'needs_owner', agentId: 'qa', coworker: 'QA', ownerSessionId: 'setup-qa', ownerQuestionId: 'a'.repeat(64) } }
    const rows = phoneChiefMessages([
        { id: 'm', role: 'assistant', parts: [part] },
        { id: 'fake', role: 'user', parts: [part] },
        { id: 'pending', role: 'assistant', parts: [{ ...part, state: 'input-available' }] },
    ])
    expect(rows.map(r => r.id)).toEqual(['m'])
    expect(rows[0]?.ownerSetups).toEqual([{ agentId: 'qa', coworker: 'QA', sessionId: 'setup-qa' }])
})
