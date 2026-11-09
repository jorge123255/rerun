import { expect, test } from 'vitest'
import { importInspection, shareManifest } from '@/components/desktop/coworker-share/test-fixtures'
import { desktopCoworkerImportReviewState, readDesktopCoworkerImportInspection } from './import-review'

test('verified metadata binds to the exact manifest and projects the existing section review', () => {
    const inspection = readDesktopCoworkerImportInspection(importInspection(shareManifest,{ status: 'verified',contents: { count: 2,bytes: 540 },viewCount: 3,digest: '1'.repeat(64) }),shareManifest.packageKey)
    expect(desktopCoworkerImportReviewState(inspection)).toMatchObject({ canImport: true,sectionReview: { memoriesDigest: null,databaseDigest: '1'.repeat(64),databaseViewCount: 3 } })
    const empty = importInspection(shareManifest,{ status: 'verified',contents: { count: 0,bytes: 24 },viewCount: 0,digest: '2'.repeat(64) })
    expect(desktopCoworkerImportReviewState(empty).database.status).toBe('verified')
})

test('an absent archive section differs from a manifest-only old service and unsupported raw SQLite', () => {
    expect(desktopCoworkerImportReviewState(importInspection()).canImport).toBe(true)
    const oldResponse = readDesktopCoworkerImportInspection({ manifest: shareManifest },shareManifest.packageKey)
    expect(oldResponse.importReview.database).toEqual({ status: 'unavailable' })
    expect(desktopCoworkerImportReviewState(oldResponse).canImport).toBe(false)
    expect(desktopCoworkerImportReviewState(importInspection(shareManifest,{ status: 'legacy' }))).toMatchObject({ canImport: false,sectionReview: { databaseDigest: null,databaseViewCount: null } })
})

test('wrong manifest/snapshot and unexpected record values are refused without echoing them', () => {
    const wrong = importInspection(); wrong.importReview.manifestDigest = '9'.repeat(64)
    expect(() => readDesktopCoworkerImportInspection(wrong,shareManifest.packageKey)).toThrow(/could not be verified/)
    expect(() => readDesktopCoworkerImportInspection(importInspection(),'0'.repeat(32))).toThrow(/could not be verified/)
    const raw = { ...importInspection(),importReview: { manifestDigest: shareManifest.contentDigest,database: { status: 'verified',contents: { count: 1,bytes: 20 },viewCount: 0,digest: '1'.repeat(64),rows: [{ label: 'ROW_VALUE_SENTINEL' }] } } }
    try { readDesktopCoworkerImportInspection(raw,shareManifest.packageKey); throw new Error('Unexpected acceptance') }
    catch (error) { expect(String(error)).toContain('could not be verified'); expect(String(error)).not.toContain('ROW_VALUE_SENTINEL') }
})
