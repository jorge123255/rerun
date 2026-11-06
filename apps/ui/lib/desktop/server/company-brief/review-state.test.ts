import { expect, it } from 'vitest'
import { applyBriefAttempt, createBriefReviewState, editBriefDraft, keepDraftForRetry, toggleBriefClaim } from './review-state'

const attempt = {
    requestId: '4f6d0c1e-7a2b-4c3d-8e9f-0a1b2c3d4e5f', chatId: 'fmc_chat0001', sourceRevision: 'a'.repeat(64),
    status: 'accepted', draft: null, result: { brief: '## Overview\n\nAcme sells widgets. [site]' },
}

it('keeps an edited draft when a delayed brief is stale or for another chat', () => {
    const edited = editBriefDraft(createBriefReviewState('fmc_chat0001', 'a'.repeat(64)), 'Corrected widgets. [site]')
    const otherChat = applyBriefAttempt(edited, { ...attempt, chatId: 'fmc_chat0002' })
    expect(otherChat.draft).toBe('Corrected widgets. [site]')
    expect(otherChat.notice).toBe('This research changed. The delayed brief was not applied.')
    const otherSource = applyBriefAttempt(edited, { ...attempt, sourceRevision: 'b'.repeat(64) })
    expect(otherSource.draft).toBe(edited.draft)
    const same = applyBriefAttempt(edited, attempt)
    expect(same.draft).toBe(edited.draft)
    expect(same.draftDirty).toBe(true)
    const fresh = applyBriefAttempt(createBriefReviewState('fmc_chat0001', 'a'.repeat(64)), attempt)
    expect(fresh.draft).toBe(attempt.result.brief)
    expect(keepDraftForRetry(edited).draft).toBe(edited.draft)
    expect(toggleBriefClaim(fresh, 'c1').selectedClaimIds).toEqual(['c1'])
})
