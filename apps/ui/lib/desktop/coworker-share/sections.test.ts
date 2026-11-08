import { expect, test } from 'vitest'
import { sharePlan } from '@/components/desktop/coworker-share/test-fixtures'
import { desktopCoworkerShareCarriedData } from './state'
import {
    DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE,
    DESKTOP_COWORKER_SHARE_E_COMPOSITION,
    DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE,
    classifyShareDestination,
    desktopCoworkerShareConfirmationPlan,
    gateShareInclude,
    isReservedCoworkerShareMetadataPath,
    refusedDestinationReason,
    sectionTransferReady,
    type DesktopCoworkerShareSectionBinding,
} from './sections'

const MEMORY_DIGEST = '1'.repeat(64)
const DATABASE_DIGEST = '2'.repeat(64)

function binding(overrides: Partial<DesktopCoworkerShareSectionBinding['preview']> = {}, authorities: DesktopCoworkerShareSectionBinding['authorities'] = { capture: true, validation: true, install: true }): DesktopCoworkerShareSectionBinding {
    return {
        authorities,
        preview: { available: true, contents: { count: 4, bytes: 80 }, digest: MEMORY_DIGEST, ...overrides },
    }
}

test('composition declares the A and B implementation revisions', () => {
    expect(DESKTOP_COWORKER_SHARE_E_COMPOSITION).toMatchObject({
        seam: 'abe-1',
        memoryImplementation: 'cb7a184d918e45899574c37232c43dba1261bd44',
        databaseImplementation: '1e1b6ea138ff3e0c3051e2607304d0ea33260ec0',
        base: '6f6ad959a09abaf1947950b6f82413c94407e22a',
        referenceTip: '406cb2661544e6d6828c36a6c4f8732d2281b3b7',
    })
})

test('missing authorities and a failed preview stay unavailable without presenting counts', () => {
    expect(sectionTransferReady('memories', undefined, null)).toMatchObject({ enabled: false, reason: DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE, contents: { count: 0, bytes: 0 }, digest: null })
    expect(sectionTransferReady('database', undefined, binding({}, { capture: true, validation: true, install: false }))).toMatchObject({ enabled: false, reason: DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE, digest: null })
    expect(sectionTransferReady('memories', undefined, binding({ available: false, reason: 'Notes could not be read.', contents: { count: 9, bytes: 90 }, digest: null }))).toEqual({
        enabled: false, reason: 'Notes could not be read.', contents: { count: 0, bytes: 0 }, digest: null, viewCount: null,
    })
    expect(sectionTransferReady('database', undefined, binding({ digest: 'AB'.repeat(32), viewCount: 2 }))).toMatchObject({ enabled: false, digest: null, contents: { count: 0, bytes: 0 } })
    expect(sectionTransferReady('memories', 'Memory transfer is unavailable.', binding())).toMatchObject({ enabled: false, reason: 'Memory transfer is unavailable.', contents: { count: 0, bytes: 0 }, digest: null })
})

test('bound available previews keep A and B counts, bytes, digest and view count', () => {
    expect(sectionTransferReady('memories', undefined, binding())).toEqual({
        enabled: true, reason: null, contents: { count: 4, bytes: 80 }, digest: MEMORY_DIGEST, viewCount: null,
    })
    expect(sectionTransferReady('database', undefined, binding({ digest: DATABASE_DIGEST, viewCount: 3, contents: { count: 2, bytes: 40 } }))).toEqual({
        enabled: true, reason: null, contents: { count: 2, bytes: 40 }, digest: DATABASE_DIGEST, viewCount: 3,
    })
    expect(sectionTransferReady('database', undefined, binding({ digest: DATABASE_DIGEST }))).toMatchObject({ enabled: false, reason: DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE })
})

test('confirmation uses preview buckets and never carries an unbound section', () => {
    const sections = {
        memories: sectionTransferReady('memories', undefined, binding()),
        database: sectionTransferReady('database', undefined, null),
    }
    const plan = desktopCoworkerShareConfirmationPlan(sharePlan, sections)
    expect(desktopCoworkerShareCarriedData(plan, { memories: true, database: true, files: true })).toEqual(['4 memories', '1 workspace file'])
    expect(gateShareInclude({ memories: true, database: true, files: true }, sharePlan, { memories: binding(), database: null }).database).toBe(false)
})

test('internal rerun metadata stays out and ordinary hidden assets stay shareable', () => {
    for (const path of [
        'workspace/.rerun-backup-old',
        'workspace/docs/.rerun-publish-id.json',
        'workspace/.RERUN-edit-alias',
        'workspace/nested/.rerun',
        'skills/.rerun-skill-tmp',
        'skills/user/.rerun-skill-hidden',
        'skills/user/nested/.RERUN-SKILL-tmp-alias',
    ]) expect(isReservedCoworkerShareMetadataPath(path)).toBe(true)
    for (const path of ['workspace/.notes.md', 'workspace/docs/.keep', 'skills/user/.notes.md', 'skills/user/.hidden-skill.md', 'SOUL.md', 'memory/note.md']) {
        expect(isReservedCoworkerShareMetadataPath(path)).toBe(false)
    }
})

test('only an imported fresh id is installed', () => {
    expect(classifyShareDestination({ status: 'imported', importedAgentId: 'fresh-a' })).toEqual({ installed: true, importedAgentId: 'fresh-a' })
    expect(classifyShareDestination({ status: 'uncertain', reason: 'unknown acknowledgement' })).toEqual({ installed: false, reason: 'unknown acknowledgement' })
    expect(classifyShareDestination({ status: 'partial', reason: 'Two tables were not installed.' })).toEqual({ installed: false, reason: 'Two tables were not installed.' })
    expect(classifyShareDestination({ status: 'unavailable', reason: 'Install writer is not bound.' })).toEqual({ installed: false, reason: 'Install writer is not bound.' })
    expect(classifyShareDestination({ status: 'reused', importedAgentId: 'fresh-a' }).installed).toBe(false)
    expect(classifyShareDestination({ status: 'imported' }).installed).toBe(false)
    expect(refusedDestinationReason({ status: 'partial', reason: 'Two tables were not installed.' })).toBe('Two tables were not installed.')
    expect(refusedDestinationReason({ status: 'imported', importedAgentId: 'fresh-a' })).toBeNull()
})
