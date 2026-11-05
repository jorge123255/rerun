import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopCoworkerCallTarget } from '../../../../packages/contracts/src/desktop-coworker-calls.ts'
import {
    desktopCoworkerMentionFields,
    desktopCoworkerMentionsFromMetadata,
    insertDesktopCoworkerMention,
    listDesktopCoworkerMentionTargets,
    reconcileDesktopCoworkerMentions,
    revalidateDesktopCoworkerMentions,
    type DesktopCoworkerMention,
} from './coworker-mentions'

const target: DesktopCoworkerCallTarget = { agentId: 'peer-1', name: 'Researcher', handle: 'researcher', boxName: 'Research', enabled: true, callable: true }
const mention: DesktopCoworkerMention = { targetId: target.agentId, token: '@researcher', start: 0, end: 11 }

afterEach(() => vi.unstubAllGlobals())

describe('immutable mention ranges', () => {
    it('records the selected ID and exact token range rather than resolving typed text', () => {
        const result = insertDesktopCoworkerMention('Ask @res please', [], { start: 4, end: 8, target })
        expect(result).toEqual({
            text: 'Ask @researcher please',
            mentions: [{ targetId: 'peer-1', token: '@researcher', start: 4, end: 15 }],
        })
    })

    it('shifts later ranges after an earlier edit and drops a mention whose token was edited', () => {
        const later = { targetId: 'peer-2', token: '@writer', start: 21, end: 28 }
        expect(reconcileDesktopCoworkerMentions('@researcher and then @writer', 'Say @researcher and then @writer', [mention, later])).toEqual([
            { ...mention, start: 4, end: 15 },
            { ...later, start: 25, end: 32 },
        ])
        expect(reconcileDesktopCoworkerMentions('@researcher', '@research', [mention])).toEqual([])
    })

    it('round-trips only range-valid persisted metadata for drafts, queues and regeneration', () => {
        const fields = desktopCoworkerMentionFields('@researcher', [mention])
        expect(fields).toEqual({ coworkerMentions: [mention] })
        expect(desktopCoworkerMentionsFromMetadata('@researcher', fields)).toEqual([mention])
        expect(desktopCoworkerMentionsFromMetadata('@research', fields)).toEqual([])
        expect(desktopCoworkerMentionsFromMetadata('@one@two', { coworkerMentions: [
            { targetId: 'peer-1', token: '@one@two', start: 0, end: 8 },
            { targetId: 'peer-2', token: '@two', start: 4, end: 8 },
        ] })).toEqual([])
    })
})

describe('send-time target revalidation', () => {
    it('resolves the immutable ID after a rename without rewriting the visible token', () => {
        const result = revalidateDesktopCoworkerMentions('@researcher', [mention], [{ ...target, name: 'New name', handle: 'new-handle' }])
        expect(result).toEqual({ ok: true, mentions: [{ ...mention, target: { ...target, name: 'New name', handle: 'new-handle' } }] })
    })

    it('cannot redirect an old selection through duplicate display names', () => {
        const other = { ...target, agentId: 'peer-2' }
        const result = revalidateDesktopCoworkerMentions('@researcher', [mention], [other, target])
        expect(result).toMatchObject({ ok: true, mentions: [{ targetId: 'peer-1', target: { agentId: 'peer-1' } }] })
    })

    it('refuses deleted, disabled, uncallable or range-mismatched selections', () => {
        expect(revalidateDesktopCoworkerMentions('@researcher', [mention], [])).toMatchObject({ ok: false })
        expect(revalidateDesktopCoworkerMentions('@researcher', [mention], [{ ...target, enabled: false }])).toMatchObject({ ok: false })
        expect(revalidateDesktopCoworkerMentions('@researcher', [mention], [{ ...target, callable: false }])).toMatchObject({ ok: false })
        expect(revalidateDesktopCoworkerMentions('@research', [mention], [target])).toMatchObject({ ok: false, code: 'range' })
    })

    it('leaves typed plain names as plain text for deterministic tool resolution', () => {
        expect(revalidateDesktopCoworkerMentions('@researcher', [], [target, { ...target, agentId: 'peer-2' }])).toEqual({ ok: true, mentions: [] })
    })
})

it('reads targets only for the current local owner', async () => {
    const fetcher = vi.fn(async () => Response.json({ targets: [target] }))
    vi.stubGlobal('fetch', fetcher)
    await expect(listDesktopCoworkerMentionTargets('owner-1')).resolves.toEqual([target])
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/coworkers/owner-1/mentions', { cache: 'no-store', signal: undefined })
})
