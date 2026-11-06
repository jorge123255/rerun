import { expect, test } from 'vitest'
import { exportInput, shareReview } from '@/components/desktop/coworker-share/test-fixtures'
import { desktopCoworkerShareCarriedData, isDesktopCoworkerShareReviewCurrent, isDesktopCoworkerShareResultCurrent } from './state'
import { sharePlan } from '@/components/desktop/coworker-share/test-fixtures'

test('review identity refuses changed workspace, source, choices and manifest digest', () => {
    const { reviewId: _reviewId, expectedDigest: _expectedDigest, ...input } = exportInput
    const reviewed = { input, result: shareReview }
    expect(isDesktopCoworkerShareReviewCurrent({ input, result: shareReview }, exportInput)).toBe(true)
    expect(isDesktopCoworkerShareReviewCurrent(reviewed, { ...exportInput, sourceRevision: '2'.repeat(64) })).toBe(false)
    expect(isDesktopCoworkerShareReviewCurrent(reviewed, { ...exportInput, workspaceId: 2 })).toBe(false)
    expect(isDesktopCoworkerShareReviewCurrent(reviewed, { ...exportInput, include: { memories: true, database: false, files: false } })).toBe(false)
    expect(isDesktopCoworkerShareResultCurrent(reviewed, { ...shareReview, manifest: { ...shareReview.manifest, contentDigest: '9'.repeat(64) } })).toBe(false)
})

test('only nonempty selected buckets trigger the original data confirmation', () => {
    expect(desktopCoworkerShareCarriedData(sharePlan, { memories: false, database: false, files: false })).toEqual([])
    expect(desktopCoworkerShareCarriedData(sharePlan, { memories: true, database: true, files: true })).toEqual([
        '1 memory', 'its database (40 B, not scanned for secrets)', '1 workspace file',
    ])
    const empty = { ...sharePlan, contents: { memories: { count: 0, bytes: 0 }, database: { count: 0, bytes: 0 }, files: { count: 0, bytes: 0 } } }
    expect(desktopCoworkerShareCarriedData(empty, { memories: true, database: true, files: true })).toEqual([])
})
