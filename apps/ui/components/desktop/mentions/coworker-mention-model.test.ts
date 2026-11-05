import { describe, expect, test } from 'vitest'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import {
    deleteDesktopCoworkerMention,
    desktopCoworkerMentionFields,
    desktopCoworkerMentionHistoryTokens,
    desktopCoworkerMentionMetadataFields,
    desktopCoworkerMentionsForRegeneration,
    insertDesktopCoworkerMention,
    reconcileDesktopCoworkerMentions,
    replaceDesktopCoworkerMention,
    restoreDesktopCoworkerMentionMetadata,
    revalidateDesktopCoworkerMentions,
    type DesktopCoworkerMention,
} from './coworker-mention-model'

const target = (patch: Partial<DesktopCoworkerCallTarget> = {}): DesktopCoworkerCallTarget => ({ agentId: 'peer-1', name: 'Ada', handle: 'ada', boxName: 'Research', enabled: true, callable: true, ...patch })
const selected: DesktopCoworkerMention = { targetId: 'peer-1', token: '@ada', start: 0, end: 4 }

describe('immutable token editing', () => {
    test('selection binds the exact ID and handle-or-name text, not a duplicate name', () => {
        const duplicate = target({ agentId: 'peer-2', handle: null })
        const inserted = insertDesktopCoworkerMention('', [], { start: 0, end: 0, target: duplicate })
        expect(inserted).toEqual({ text: '@Ada ', mentions: [{ targetId: 'peer-2', token: '@Ada', start: 0, end: 4 }] })
        expect(revalidateDesktopCoworkerMentions(inserted.text, inserted.mentions, [target(), duplicate]).ok).toBe(true)
    })

    test('email and embedded text cannot become selected metadata', () => {
        expect(desktopCoworkerMentionFields('mail@ada.com', [{ targetId: 'peer-1', token: '@ada', start: 4, end: 8 }])).toEqual({ coworkerMentions: [] })
        expect(desktopCoworkerMentionFields('prefix@ada', [{ targetId: 'peer-1', token: '@ada', start: 6, end: 10 }])).toEqual({ coworkerMentions: [] })
    })

    test('range edits shift unaffected records and invalidate only the edited token', () => {
        const two = [{ ...selected }, { targetId: 'peer-2', token: '@bea', start: 5, end: 9 }]
        expect(reconcileDesktopCoworkerMentions('@ada @bea', 'say @ada @bea', two)).toEqual([{ ...selected, start: 4, end: 8 }, { targetId: 'peer-2', token: '@bea', start: 9, end: 13 }])
        expect(reconcileDesktopCoworkerMentions('@ada @bea', '@ad @bea', two)).toEqual([{ targetId: 'peer-2', token: '@bea', start: 4, end: 8 }])
        expect(deleteDesktopCoworkerMention('@ada @bea', two, two[0])).toEqual({ text: '@bea', mentions: [{ targetId: 'peer-2', token: '@bea', start: 0, end: 4 }] })
    })

    test('replacement binds a new exact ID and shifts later ranges without doubling spaces', () => {
        const two = [{ ...selected }, { targetId: 'peer-2', token: '@bea', start: 5, end: 9 }]
        expect(replaceDesktopCoworkerMention('@ada @bea', two, two[0], target({ agentId: 'peer-3', handle: 'cleo' }))).toEqual({
            text: '@cleo @bea',
            mentions: [{ targetId: 'peer-3', token: '@cleo', start: 0, end: 5 }, { targetId: 'peer-2', token: '@bea', start: 6, end: 10 }],
        })
    })

    test('a disabled or uncallable target cannot be selected even by a direct helper caller', () => {
        expect(() => insertDesktopCoworkerMention('', [], { start: 0, end: 0, target: target({ enabled: false }) })).toThrow()
        expect(() => insertDesktopCoworkerMention('', [], { start: 0, end: 0, target: target({ callable: false }) })).toThrow()
    })
})

describe('send revalidation', () => {
    test.each([
        ['deleted', []],
        ['disabled', [target({ enabled: false })]],
        ['revoked', [target({ callable: false })]],
        ['duplicate identity', [target(), target()]],
    ])('refuses a %s current target without re-resolving by name', (_reason, targets) => {
        expect(revalidateDesktopCoworkerMentions('@ada ', [selected], targets)).toMatchObject({ ok: false, code: 'target' })
    })

    test('a rename preserves the old visible token and exact selected ID', () => {
        const renamed = target({ name: 'Renamed', handle: 'new-handle' })
        const result = revalidateDesktopCoworkerMentions('@ada ', [selected], [renamed])
        expect(result).toMatchObject({ ok: true, mentions: [{ targetId: 'peer-1', token: '@ada', target: renamed }] })
    })

    test('a stale range or overlapping records refuse admission', () => {
        expect(revalidateDesktopCoworkerMentions('@ada changed', [selected], [target()])).toMatchObject({ ok: false, code: 'range' })
        expect(revalidateDesktopCoworkerMentions('@ada', [selected, { ...selected, targetId: 'peer-2' }], [target(), target({ agentId: 'peer-2' })])).toMatchObject({ ok: false, code: 'range' })
    })

    test('plain typed names stay plain text', () => {
        expect(revalidateDesktopCoworkerMentions('Ada, please review', [], [target()])).toEqual({ ok: true, mentions: [] })
    })
})

describe('versioned durable metadata', () => {
    const identity = { agentId: 'owner', sessionId: 'chat', tabUid: 'tab-a', requestId: 'request-a' }
    const text = '@ada please review'

    test('round-trips draft, queued and acknowledged identity without a separate store', () => {
        const fields = desktopCoworkerMentionMetadataFields(identity, text, [{ ...selected }])
        expect(fields.coworkerMentionMetadata).toMatchObject({ version: 1, agentId: 'owner', sessionId: 'chat', tabUid: 'tab-a', requestId: 'request-a', text })
        expect(restoreDesktopCoworkerMentionMetadata(identity, text, fields)).toEqual({ ok: true, mentions: [selected] })
    })

    test.each([
        ['owner', { ...identity, agentId: 'other' }],
        ['session', { ...identity, sessionId: 'other' }],
        ['tab', { ...identity, tabUid: 'tab-b' }],
        ['acknowledgement', { ...identity, requestId: 'request-b' }],
    ])('refuses a different %s', (_field, otherIdentity) => {
        const fields = desktopCoworkerMentionMetadataFields(identity, text, [selected])
        expect(restoreDesktopCoworkerMentionMetadata(otherIdentity, text, fields)).toMatchObject({ ok: false, code: 'owner' })
    })

    test('refuses an edited body, damaged range or unsupported version', () => {
        const fields = desktopCoworkerMentionMetadataFields(identity, text, [selected])
        expect(restoreDesktopCoworkerMentionMetadata(identity, '@ada edited', fields)).toMatchObject({ ok: false, code: 'body' })
        expect(restoreDesktopCoworkerMentionMetadata(identity, text, { coworkerMentionMetadata: { ...fields.coworkerMentionMetadata, version: 2 } })).toMatchObject({ ok: false, code: 'version' })
        expect(restoreDesktopCoworkerMentionMetadata(identity, text, { coworkerMentionMetadata: { ...fields.coworkerMentionMetadata, mentions: [{ ...selected, end: 3 }] } })).toMatchObject({ ok: false, code: 'range' })
    })

    test('independent tabs cannot exchange selected IDs', () => {
        const first = desktopCoworkerMentionMetadataFields({ ...identity, tabUid: 'tab-a' }, text, [selected])
        const second = desktopCoworkerMentionMetadataFields({ ...identity, tabUid: 'tab-b' }, text, [{ ...selected, targetId: 'peer-2' }])
        expect(restoreDesktopCoworkerMentionMetadata({ ...identity, tabUid: 'tab-a' }, text, second)).toMatchObject({ ok: false })
        expect(restoreDesktopCoworkerMentionMetadata({ ...identity, tabUid: 'tab-a' }, text, first)).toMatchObject({ ok: true, mentions: [selected] })
    })
})

test('history and regeneration preserve the original display token without retroactive renames', () => {
    const metadata = desktopCoworkerMentionFields('@ada old result', [selected])
    expect(desktopCoworkerMentionHistoryTokens('@ada old result', metadata)).toEqual([{ text: '@ada', kind: 'agent' }])
    expect(desktopCoworkerMentionsForRegeneration('@ada old result', '@ada new request', metadata)).toEqual([selected])
    expect(() => desktopCoworkerMentionsForRegeneration('@ada old result', '@ada new request', { coworkerMentions: [{ ...selected, end: 2 }] })).toThrow()
})
