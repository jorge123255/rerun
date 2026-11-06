import 'server-only'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Client } from '@libsql/client'
import { request } from '@/lib/engine/client'
import { inspectCoworker } from '../../../../../engine/src/desktop/templates/inspect'
import { bindDesktopServiceSkillOwners } from '../service-skills/authority'
import { trustedSkillOwners } from '../../../../../engine/src/desktop/service-skills/authority'
import { readPortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { importDesktopPortableTemplate } from '../../../../../engine/src/desktop/templates/portable-import'
import { isTemplateManifestPath } from '../../../../../engine/src/desktop/templates/install'
import { desktopCoworkerShareSourceSchema, desktopTemplateInstallResultSchema, type DesktopCoworkerShareSource } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { readDesktopRuntime, canonicalDesktopEngineRoot, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { findDesktopAgent } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { createDesktopTemplateServer, type DesktopTemplateEngineClient } from '../templates/server'
import { desktopTemplateAuthority } from '../templates/authority'
import { commitDesktopTemplateInstall } from '../templates/commit'
import { prepareTemplateIntent } from '../templates/intents'
import { createDesktopCoworkerShareStore, shareFingerprint } from './store'
import { createDesktopCoworkerShareService } from './service'
import { createDesktopCoworkerShareApi } from './api'
import { createDesktopCoworkerShareAttemptStore } from './attempts'

const stableId = (parts: unknown[]) => {
    const hex = shareFingerprint(parts)
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
async function current(runtime: DesktopRuntime, mutable: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const now = await readDesktopRuntime()
    if (JSON.stringify([now.dataRoot,now.workspaceId,now.launchNonce,now.engine.origin]) !== JSON.stringify([runtime.dataRoot,runtime.workspaceId,runtime.launchNonce,runtime.engine.origin])) throw new DesktopHttpError(409,'The share workspace changed.')
    signal?.throwIfAborted()
    if (mutable) assertDesktopWorkspaceAdmission(runtime)
}

/** Uses the accepted confined template inspector and trusted skill ownership; never walks raw accounts/history. */
export async function readCurrentDesktopCoworkerShareSource(runtime: DesktopRuntime, db: Client, workspaceId: number, agentId: string, signal?: AbortSignal): Promise<DesktopCoworkerShareSource> {
    await current(runtime,false,signal)
    if (workspaceId !== runtime.workspaceId) throw new DesktopHttpError(404,'Coworker not found in this workspace.')
    await assertCoworkerNotDeleting(db,agentId)
    const owner = await findDesktopAgent(db,agentId)
    if (!owner) throw new DesktopHttpError(404,'Coworker not found.')
    const root = await canonicalDesktopEngineRoot(runtime), agentsRoot = join(root,'agents')
    bindDesktopServiceSkillOwners(runtime)
    const ownership = await trustedSkillOwners(join(agentsRoot,owner.engineAgentId,'workspace'))
    const inspected = await inspectCoworker(agentsRoot,agentId,owner.engineAgentId,{ includeBinary: true,requireTrustedOwnership: true,skillOwnership: ({ slug }) => ownership.has(slug) || slug.startsWith('svc-') ? 'connector' : 'user' })
    if (inspected.blocked) throw new DesktopHttpError(409,'This coworker cannot be safely shared until its source is available.')
    await current(runtime,false,signal)
    await assertCoworkerNotDeleting(db,agentId)
    const fresh = await findDesktopAgent(db,agentId)
    if (!fresh || fresh.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(409,'The coworker was replaced during review.')
    const files = [inspected.soul,inspected.install,inspected.config,...inspected.selectableFiles,...inspected.selectableSkills.flatMap(skill => skill.files)].filter((file): file is NonNullable<typeof file> => file !== null)
    const members = files.map(file => ({ path: file.path,bytes: Buffer.from(file.raw),kind: file.path === 'config.json' ? 'config' as const : ['SOUL.md','INSTALL.md'].includes(file.path) ? 'instruction' as const : file.path.startsWith('skills/') ? 'skill' as const : file.binary ? 'binary' as const : 'text' as const,binary: file.binary,textScanned: file.textScanned,flagged: file.flagged,ownership: 'user' as const }))
    const body = { workspaceId,agentId,name: inspected.name,description: inspected.description,setup: inspected.setup,config: inspected.config?.text ? JSON.parse(inspected.config.text) : {},envKeys: inspected.envKeys,mcpAuth: inspected.mcpAuth,members }
    return desktopCoworkerShareSourceSchema.parse({ ...body,revision: shareFingerprint([body.workspaceId,body.agentId,body.name,body.description,body.setup,body.config,body.envKeys,body.mcpAuth,members.map(file => [file.path,createHash('sha256').update(file.bytes).digest('hex'),file.ownership,file.flagged])]) })
}

/** Verify immutable native-picked bytes before persisting them; picking alone never installs. */
export async function ingestDesktopCoworkerShareArchive(runtime: DesktopRuntime, bytes: Uint8Array) {
    await current(runtime,true)
    const archiveBytes = Buffer.from(bytes), restored = await readPortableArchive(archiveBytes)
    if (restored.manifest.coworkers.length !== 1) throw new DesktopHttpError(400,'A coworker share must contain exactly one coworker.')
    const store = createDesktopCoworkerShareStore(await openDesktopDatabase(runtime.dataRoot))
    await current(runtime,true)
    await store.create({ ...restored,archiveBytes,archiveSha256: createHash('sha256').update(archiveBytes).digest('hex') })
    return { snapshotId: restored.manifest.packageKey }
}

export async function openDesktopCoworkerShareBinding(runtime: DesktopRuntime, routeAgentId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot), store = createDesktopCoworkerShareStore(db)
    const engine = engineOf(runtime)
    const engineClient: DesktopTemplateEngineClient = {
        get: (path,signal) => request(engine,path,{ method: 'GET',signal,cache: 'no-store' },value => value),
        post: (path,body,signal) => request(engine,path,{ method: 'POST',body: JSON.stringify(body),signal },value => value),
    }
    async function install(snapshotId: string, targetWorkspaceId: number, requestId: string) {
        if (targetWorkspaceId !== runtime.workspaceId) throw new DesktopHttpError(409,'Switch to the target workspace before importing.')
        await current(runtime,true)
        const archive = await store.readArchive(snapshotId), restored = await readPortableArchive(archive.bytes)
        if (restored.members.some(member => !isTemplateManifestPath(member.path))) throw new DesktopHttpError(409,'This share contains memory or database content unsupported by the current canonical template installer.')
        const engineRoot = await canonicalDesktopEngineRoot(runtime)
        const imported = await importDesktopPortableTemplate({ requestId: stableId(['share-package',runtime.workspaceId,snapshotId,requestId]),uploadId: stableId(['share-upload',snapshotId]),deps: { dataRoot: engineRoot,readImmutableUpload: async () => Buffer.from(archive.bytes) } })
        if (imported.status !== 'imported') throw new DesktopHttpError(503,'The canonical package import is not confirmed.')
        await current(runtime,true)
        const installId = stableId(['share-install',runtime.workspaceId,snapshotId,requestId])
        const operation = await prepareTemplateIntent(db,engineClient,{ operation: { operation: 'install',templateId: imported.templateId,revision: imported.revision } },{ requestId: installId,scopeKey: `foreman:share:${runtime.workspaceId}:${snapshotId}` })
        const canonical = desktopTemplateAuthority(runtime)
        const templates = createDesktopTemplateServer({ db,engine: engineClient,foremanDisabled: true,
            initializeImportedSetup: async input => { await current(runtime,true); return canonical.initializeImportedSetup(input) },
            commitInstalled: async input => { await current(runtime,true); return commitDesktopTemplateInstall(db,input,{ enabled: false }) },
        })
        const parsed = desktopTemplateInstallResultSchema.safeParse(await templates.handle(operation))
        if (!parsed.success || parsed.data.status !== 'installed' || parsed.data.coworkers.length !== 1) throw new DesktopHttpError(503,'The canonical coworker installation is not confirmed.')
        await current(runtime,true)
        return parsed.data.coworkers[0]!.id
    }
    const service = createDesktopCoworkerShareService(store,{
        unavailable: { memories: 'Memory transfer is unavailable in this version. Existing memories stay on this Mac.', database: 'Database transfer is unavailable in this version. Existing tables stay on this Mac.' },
        assertCurrent: async input => {
            await current(runtime,input.operation !== 'read')
            if (input.workspaceId !== undefined && input.workspaceId !== runtime.workspaceId || input.agentId !== undefined && input.agentId !== routeAgentId) throw new DesktopHttpError(404,'This share belongs to another workspace or coworker.')
        },
        install: input => install(input.manifest.packageKey,input.targetWorkspaceId,input.requestId),
        recoverImport: input => install(input.snapshotId,input.targetWorkspaceId,input.requestId),
    })
    const source = (workspaceId: number,agentId: string,signal?: AbortSignal) => {
        if (agentId !== routeAgentId) throw new DesktopHttpError(404,'This share belongs to another coworker.')
        return readCurrentDesktopCoworkerShareSource(runtime,db,workspaceId,agentId,signal)
    }
    const attempts = createDesktopCoworkerShareAttemptStore(db,runtime.workspaceId,routeAgentId)
    return { service,store,source,api: createDesktopCoworkerShareApi(service,source,async input => { await current(runtime,false); return attempts(input) }) }
}
