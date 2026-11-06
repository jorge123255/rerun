import { DESKTOP_PORTABLE_TEMPLATE_LIMITS, DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING, type DesktopCoworkerShareReviewResult, type DesktopCoworkerSnapshotManifest } from '@rerun/contracts'

export const shareManifest: DesktopCoworkerSnapshotManifest = {
    format: 'desktop-portable-template',
    formatVersion: 1,
    packageKey: 'a'.repeat(32),
    title: 'Ada',
    capturedAt: '2026-11-06T00:00:00.000Z',
    proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
    limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    contentDigest: 'b'.repeat(64),
    coworkers: [{
        agentKey: 'c01', name: 'Ada', description: 'Researcher',
        setup: { required: false, prompt: '', answered: false },
        members: [
            { path: 'SOUL.md', bytes: 12, kind: 'instruction', contentDigest: 'c'.repeat(64), flagged: [], binary: false, textScanned: true },
            { path: 'skills/research/SKILL.md', bytes: 24, kind: 'skill', contentDigest: 'd'.repeat(64), flagged: [], binary: false, textScanned: true },
            { path: 'workspace/image.bin', bytes: 7, kind: 'binary', contentDigest: 'e'.repeat(64), flagged: [], binary: true, textScanned: false },
        ],
        exclusions: [{ path: '.env', reason: 'credentials' }],
        redactions: [], strippedConfigKeys: [], requirements: [], envKeys: [], mcpAuth: [],
    }],
    fidelity: { binaryAssets: true, userSkillTrees: true, sourceKind: 'local-v1-export', notes: [] },
    excludedCategories: ['credentials', 'history', 'native-grant'],
}

export const shareReview: DesktopCoworkerShareReviewResult = {
    manifest: shareManifest,
    archiveSha256: 'f'.repeat(64),
    archiveBytes: 128,
    reused: false,
    reviewId: 'a'.repeat(64),
}

export const sharePlan = {
    agentName: 'Ada',
    warnings: ['Binary files are not text-scanned for secrets.'],
    envKeyCount: 0,
    mcpAuthCount: 0,
    contents: {
        memories: { count: 1, bytes: 20 },
        database: { count: 1, bytes: 40 },
        files: { count: 1, bytes: 7 },
    },
}

export const exportInput = {
    workspaceId: 1,
    agentId: 'agent-a',
    sourceRevision: '1'.repeat(64),
    requestId: '11111111-1111-4111-8111-111111111111',
    include: { memories: false, database: false, files: false },
    reviewId: shareReview.reviewId,
    expectedDigest: shareManifest.contentDigest,
}
