export type BriefReviewState = {
    chatId: string
    sourceRevision: string
    requestId: string | null
    draft: string
    draftDirty: boolean
    selectedClaimIds: string[]
    status: string | null
    notice: string | null
}

export type BriefReviewAttempt = {
    requestId: string
    chatId: string
    sourceRevision: string
    status: string
    draft: string | null
    result: { brief: string } | null
}

export function createBriefReviewState(chatId: string, sourceRevision: string): BriefReviewState {
    return { chatId, sourceRevision, requestId: null, draft: '', draftDirty: false, selectedClaimIds: [], status: null, notice: null }
}

// A late result for another chat or source revision does not replace the draft.
export function applyBriefAttempt(state: BriefReviewState, attempt: BriefReviewAttempt): BriefReviewState {
    if (attempt.chatId !== state.chatId || attempt.sourceRevision !== state.sourceRevision) {
        return { ...state, notice: 'This research changed. The delayed brief was not applied.' }
    }
    return {
        ...state,
        requestId: attempt.requestId,
        status: attempt.status,
        draft: state.draftDirty ? state.draft : attempt.draft ?? attempt.result?.brief ?? state.draft,
        notice: attempt.status === 'stale'
            ? 'This research changed. Review the current sources before deciding.'
            : attempt.status === 'cancelled' ? 'Company research was stopped.' : null,
    }
}

export function editBriefDraft(state: BriefReviewState, brief: string): BriefReviewState {
    return { ...state, draft: brief, draftDirty: true, notice: null }
}

export function toggleBriefClaim(state: BriefReviewState, claimId: string): BriefReviewState {
    const selectedClaimIds = state.selectedClaimIds.includes(claimId)
        ? state.selectedClaimIds.filter(id => id !== claimId)
        : [...state.selectedClaimIds, claimId]
    return { ...state, selectedClaimIds }
}

export function keepDraftForRetry(state: BriefReviewState): BriefReviewState {
    return { ...state, status: 'pending', notice: null }
}
