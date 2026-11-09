import {
    DESKTOP_COWORKER_SHARE_FILES_NOT_SELECTED,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
    type DesktopCoworkerImportPlan,
    type DesktopCoworkerShareInclude,
    type DesktopCoworkerSharePlan,
    type DesktopCoworkerShareSource,
    type DesktopCoworkerSnapshotManifest,
    desktopCoworkerImportPlanSchema,
    desktopCoworkerShareSourceSchema,
    scanPathForSecrets,
} from '@rerun/contracts'
import { sealPortableManifest, writePortableArchive, type PortablePackageMemberBytes } from '../templates/portable-package.ts'
import { sha256 } from '../templates/hash.ts'
import { scrubConfig } from '../templates/inspect.ts'
import { isReservedTemplateMetadataPath } from '../templates/files.ts'
export type { DesktopCoworkerShareSource } from '@rerun/contracts'

export type DesktopCoworkerSnapshot = {
    manifest: DesktopCoworkerSnapshotManifest
    members: PortablePackageMemberBytes[]
    archiveBytes: Buffer
    archiveSha256: string
}

function includeMember(path: string, ownership: string, include: DesktopCoworkerShareInclude, flagged: readonly string[] = []): boolean {
    if (ownership !== 'user' || isReservedTemplateMetadataPath(path) || scanPathForSecrets(path).length || path.split('/').some(part => part === '.rerun' || part === '.git' || part === 'node_modules')) return false
    if (path.startsWith('memory/')) return include.memories && flagged.length === 0 && /\.(?:md|txt|json)$/.test(path)
    if (path === 'data/agent.db') return include.database
    if (path.startsWith('workspace/')) return include.files
    return ['SOUL.md','INSTALL.md','config.json'].includes(path) || /^skills\/[^/]+\/.+/.test(path)
}

function exclusionReason(path: string, ownership: string, flagged: readonly string[] = []): 'credentials' | 'history' | 'memory' | 'database' | 'connector-skill' | 'service-registry' | 'native-grant' | 'routine' | 'webhook' | 'system-skill' {
    if (path === '.env' || path === 'data/system.db' || scanPathForSecrets(path).length) return 'credentials'
    if (path.startsWith('memory/')) return flagged.length ? 'credentials' : 'memory'
    if (path === 'data/agent.db') return 'database'
    if (path.startsWith('schedules/')) return 'routine'
    if (path.startsWith('triggers/')) return 'webhook'
    if (ownership === 'connector') return 'connector-skill'
    if (ownership === 'system') return 'system-skill'
    return 'native-grant'
}

export async function createDesktopCoworkerSnapshot(source: DesktopCoworkerShareSource, include: DesktopCoworkerShareInclude, workspaceId = source.workspaceId): Promise<DesktopCoworkerSnapshot> {
    const parsed = desktopCoworkerShareSourceSchema.parse(source)
    const members: PortablePackageMemberBytes[] = []
    const exclusions: { path: string; reason: ReturnType<typeof exclusionReason> }[] = []
    const strippedConfigKeys: string[] = []
    const withWorkspaceFiles = { ...include, files: true }
    for (const member of [...parsed.members].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!includeMember(member.path, member.ownership, include, member.flagged)) {
            // The Files choice is recorded once in the manifest. Keep paths and individual
            // reasons for security exclusions, while leaving unselected user filenames private.
            const omittedByChoice = !include.files && member.path.startsWith('workspace/')
                && includeMember(member.path, member.ownership, withWorkspaceFiles, member.flagged)
            if (!omittedByChoice) exclusions.push({ path: member.path, reason: exclusionReason(member.path, member.ownership, member.flagged) })
            continue
        }
        let bytes = Buffer.from(member.bytes)
        if (member.path === 'config.json') {
            const cleaned = scrubConfig(JSON.parse(bytes.toString('utf8')),parsed.name)
            if ('error' in cleaned) throw new Error('The coworker configuration cannot be safely shared.')
            strippedConfigKeys.push(...cleaned.stripped)
            bytes = Buffer.from(`${JSON.stringify({ ...JSON.parse(cleaned.text),enabled: false },null,2)}\n`)
        }
        members.push({ agentKey: 'c01', path: member.path, bytes, digest: sha256(bytes) })
    }
    const requirements = [
        ...parsed.envKeys.map(name => ({ kind: 'environment-key' as const, name })),
        ...parsed.mcpAuth.map(entry => ({ kind: 'mcp-reconnect' as const, name: entry.server, detail: entry.kind })),
        ...parsed.members.filter(member => member.path.startsWith('schedules/')).map(member => ({ kind: 'schedule-inactive' as const, name: member.path })),
        ...parsed.members.filter(member => member.path.startsWith('triggers/')).map(member => ({ kind: 'trigger-inactive' as const, name: member.path })),
    ]
    const body = {
        format: 'desktop-portable-template' as const,
        formatVersion: 1 as const,
        packageKey: sha256(JSON.stringify([workspaceId, parsed.agentId, parsed.revision, include])).slice(0, 32),
        title: parsed.name,
        capturedAt: new Date().toISOString(),
        proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
        limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers: [{
            agentKey: 'c01', name: parsed.name, description: parsed.description,
            setup: { required: parsed.setup.required, prompt: parsed.setup.prompt, answered: false },
            members: parsed.members.filter(member => includeMember(member.path, member.ownership, include, member.flagged)).map(member => ({
                path: member.path, bytes: members.find(candidate => candidate.path === member.path)!.bytes.length,
                kind: member.kind, contentDigest: members.find(candidate => candidate.path === member.path)!.digest,
                flagged: member.flagged, binary: member.binary, textScanned: member.textScanned,
            })),
            exclusions,
            redactions: strippedConfigKeys.length ? [{ path: 'config.json', reason: 'Credentials, provider/model binding and inherited grants were removed.' }] : [],
            strippedConfigKeys,
            requirements,
            envKeys: parsed.envKeys,
            mcpAuth: parsed.mcpAuth,
        }],
        fidelity: {
            binaryAssets: true,
            userSkillTrees: true,
            sourceKind: 'local-v1-export' as const,
            notes: [DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING, ...(!include.files ? [DESKTOP_COWORKER_SHARE_FILES_NOT_SELECTED] : [])],
        },
        excludedCategories: [
            'credentials', 'history', ...(!include.memories ? ['memory', 'private-memory'] as const : []), 'database', 'connector-skill', 'system-skill', 'service-registry', 'native-grant', 'tool-permissions',
            'active-schedule', 'active-trigger', 'browser-profile', 'paid-data', 'cached-pages', 'chat-transcript', 'tool-arguments', 'telemetry', 'marketplace', 'hosted-publish',
        ] as DesktopCoworkerSnapshotManifest['excludedCategories'],
    }
    const manifest = sealPortableManifest(body)
    const archive = await writePortableArchive({ title: parsed.name, packageKey: manifest.packageKey, manifest, members, startedAt: Date.now() })
    return { manifest, members, archiveBytes: archive.archiveBytes, archiveSha256: sha256(archive.archiveBytes) }
}

export function createDesktopCoworkerImportPlan(_manifest: DesktopCoworkerSnapshotManifest): DesktopCoworkerImportPlan {
    return desktopCoworkerImportPlanSchema.parse({ capabilities: { enabled: false, history: 'empty', connectionId: null, provider: null, model: null, grants: 'off' } })
}

export function createDesktopCoworkerSharePlan(source: DesktopCoworkerShareSource): DesktopCoworkerSharePlan {
    const eligible = source.members.filter(member => includeMember(member.path, member.ownership, { memories: true, database: true, files: true }, member.flagged))
    const count = (prefix: string) => eligible.filter(member => member.path.startsWith(prefix))
    const sum = (paths: string[]) => eligible.filter(member => paths.includes(member.path)).reduce((total, member) => total + member.bytes.length, 0)
    return {
        agentName: source.name,
        warnings: ['Selected instructions, files, skills and binary assets are copied as written. Binary files are not text-scanned for secrets.', 'The Box database and the Box shared files stay here: a copy starts with an empty one.'],
        envKeyCount: source.envKeys.length,
        mcpAuthCount: source.mcpAuth.length,
        contents: {
            memories: { count: count('memory/').length, bytes: count('memory/').reduce((total, member) => total + member.bytes.length, 0) },
            database: { count: sum(['data/agent.db']) ? 1 : 0, bytes: sum(['data/agent.db']) },
            files: { count: count('workspace/').length, bytes: count('workspace/').reduce((total, member) => total + member.bytes.length, 0) },
        },
    }
}
