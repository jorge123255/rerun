import { describe, expect, it } from 'vitest'
import type { DesktopForemanChatRef, DesktopForemanConversationView } from '@rerun/contracts'
import { checkForemanRegenerate, FOREMAN_REGENERATE_REFUSAL, type ForemanRegenerateInput } from './regenerate'

const chat: DesktopForemanChatRef = { workspaceId: '1', chatId: 'fmc_abcdefgh' }
const other: DesktopForemanChatRef = { workspaceId: '1', chatId: 'fmc_otherchat' }

const view = (patch: Partial<DesktopForemanConversationView> = {}): DesktopForemanConversationView => ({
    contractVersion: 1, chat, phase: 'companion', live: null, revisions: [], currentRevisionId: null,
    decisions: [], build: null, discovery: null, blocked: null, ...patch,
})

const reply = (patch: Record<string, unknown> = {}) => ({ id: 'engine-abc123', role: 'assistant', text: 'Saved answer.', chat, ...patch })

const input = (patch: Partial<ForemanRegenerateInput> = {}): ForemanRegenerateInput => ({
    chat, view: view(), message: reply(), pendingQuestion: false,
    renderedRevision: 'rev-1', currentRevision: 'rev-1', previousUserText: 'Plan my week.', durableAlternate: true, ...patch,
})

describe('checkForemanRegenerate', () => {
    it('allows exactly a saved engine reply of this chat, with its question', () => {
        expect(checkForemanRegenerate(input())).toEqual({ ok: true, messageId: 'engine-abc123' })
    })

    it('refuses until a durable replacement or reachable alternate exists', () => {
        expect(checkForemanRegenerate(input({ durableAlternate: false }))).toEqual({ ok: false, reason: 'no-durable-alternate' })
        expect(FOREMAN_REGENERATE_REFUSAL['no-durable-alternate']).toContain('beside this one')
    })

    it('refuses a live turn, a running build, a pending question or a pending decision', () => {
        expect(checkForemanRegenerate(input({ view: view({ live: { runId: 'run-1', model: { connectionId: 'c', model: 'm' } } }) }))).toEqual({ ok: false, reason: 'active-turn' })
        expect(checkForemanRegenerate(input({ view: view({ build: { state: 'running' } as never }) }))).toEqual({ ok: false, reason: 'active-build' })
        expect(checkForemanRegenerate(input({ pendingQuestion: true }))).toEqual({ ok: false, reason: 'pending-question' })
        expect(checkForemanRegenerate(input({ view: view({ blocked: 'decision_uncertain' }) }))).toEqual({ ok: false, reason: 'pending-approval' })
        expect(checkForemanRegenerate(input({ view: view({ decisions: [{ state: 'pending' } as never] }) }))).toEqual({ ok: false, reason: 'pending-approval' })
    })

    it('refuses a stale row and a reply from another chat', () => {
        expect(checkForemanRegenerate(input({ renderedRevision: 'rev-1', currentRevision: 'rev-2' }))).toEqual({ ok: false, reason: 'stale-reply' })
        expect(checkForemanRegenerate(input({ view: view({ chat: other }) }))).toEqual({ ok: false, reason: 'foreign-chat' })
        expect(checkForemanRegenerate(input({ message: reply({ chat: other }) }))).toEqual({ ok: false, reason: 'foreign-chat' })
    })

    it('refuses anything that is not a saved engine reply with its question', () => {
        expect(checkForemanRegenerate(input({ message: null }))).toEqual({ ok: false, reason: 'not-engine-reply' })
        expect(checkForemanRegenerate(input({ message: reply({ id: 'hub-1' }) }))).toEqual({ ok: false, reason: 'not-engine-reply' })
        expect(checkForemanRegenerate(input({ message: reply({ role: 'user' }) }))).toEqual({ ok: false, reason: 'not-engine-reply' })
        expect(checkForemanRegenerate(input({ message: reply({ text: '  ' }) }))).toEqual({ ok: false, reason: 'not-engine-reply' })
        expect(checkForemanRegenerate(input({ previousUserText: null }))).toEqual({ ok: false, reason: 'no-preceding-turn' })
        expect(checkForemanRegenerate(input({ view: null }))).toEqual({ ok: false, reason: 'foreign-chat' })
    })
})
