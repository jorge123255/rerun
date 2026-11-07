import { expect, test } from 'vitest'
import { exportInput, shareReview } from '@/components/desktop/coworker-share/test-fixtures'
import { desktopCoworkerShareCarriedData, isDesktopCoworkerShareReviewCurrent, isDesktopCoworkerShareResultCurrent, isDesktopCoworkerShareSectionDigestCurrent } from './state'
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

test('an existing archive remains reviewable only for the same owner, source, choices and package', () => {
    const reviewed = { input: exportInput, result: { ...shareReview, reused: true } }
    expect(isDesktopCoworkerShareReviewCurrent(reviewed, exportInput)).toBe(true)
    for (const changed of [
        { ...exportInput, agentId: 'another-owner' },
        { ...exportInput, workspaceId: 2 },
        { ...exportInput, sourceRevision: '2'.repeat(64) },
        { ...exportInput, include: { ...exportInput.include, files: true } },
    ]) expect(isDesktopCoworkerShareReviewCurrent(reviewed, changed)).toBe(false)
    expect(isDesktopCoworkerShareReviewCurrent({ ...reviewed, result: { ...reviewed.result, reviewId: '9'.repeat(64) } }, exportInput)).toBe(false)
    expect(isDesktopCoworkerShareResultCurrent(reviewed, { ...shareReview, archiveSha256: '9'.repeat(64) })).toBe(false)
})

test('only nonempty selected buckets trigger the original data confirmation', () => {
    expect(desktopCoworkerShareCarriedData(sharePlan, { memories: false, database: false, files: false })).toEqual([])
    expect(desktopCoworkerShareCarriedData(sharePlan, { memories: true, database: true, files: true })).toEqual([
        '1 memory', 'its database (40 B, not scanned for secrets)', '1 workspace file',
    ])
    const empty = { ...sharePlan, contents: { memories: { count: 0, bytes: 0 }, database: { count: 0, bytes: 0 }, files: { count: 0, bytes: 0 } } }
    expect(desktopCoworkerShareCarriedData(empty, { memories: true, database: true, files: true })).toEqual([])
})

test('a changed section digest blocks the reviewed archive without rewriting the file digest', () => {
    const { reviewId: _reviewId, expectedDigest: _expectedDigest, ...input } = exportInput
    const reviewed = { input: { ...input, include: { memories: true, database: false, files: false } }, result: shareReview, sections: { memoriesDigest: '1'.repeat(64), databaseDigest: null, databaseViewCount: null } }
    expect(isDesktopCoworkerShareSectionDigestCurrent(reviewed, { memories: { enabled: true, digest: '1'.repeat(64) }, database: { enabled: false, digest: null } })).toBe(true)
    expect(isDesktopCoworkerShareSectionDigestCurrent(reviewed, { memories: { enabled: true, digest: '2'.repeat(64) }, database: { enabled: false, digest: null } })).toBe(false)
    expect(isDesktopCoworkerShareSectionDigestCurrent(reviewed, { memories: { enabled: false, digest: null }, database: { enabled: false, digest: null } })).toBe(false)
    expect(isDesktopCoworkerShareResultCurrent(reviewed, shareReview)).toBe(true)
})
