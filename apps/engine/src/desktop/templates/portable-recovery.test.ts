import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import {
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
} from '@rerun/contracts'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { sha256 } from './hash.js'
import { createDesktopPortableTemplateService } from './portable-service.js'
import { readPortableArchive, sealPortableManifest, writePortableArchive } from './portable-package.js'
import { listTemplateIds, readOwnJson, templateHome } from './store.js'

const fault = vi.hoisted(() => ({
    afterJson: undefined as undefined | ((directory: string, name: string, value: unknown) => Promise<void>),
    beforeRemove: undefined as undefined | ((path: string, recursive: boolean) => Promise<void>),
    afterRemove: undefined as undefined | ((path: string, recursive: boolean) => Promise<void>),
}))

vi.mock('./store.js', async importOriginal => {
    const actual = await importOriginal<typeof import('./store.js')>()
    return {
        ...actual,
        writeOwnJson: async (...args: Parameters<typeof actual.writeOwnJson>) => {
            await actual.writeOwnJson(...args)
            await fault.afterJson?.(...args)
        },
        replaceOwnJson: async (...args: Parameters<typeof actual.replaceOwnJson>) => {
            await actual.replaceOwnJson(...args)
            await fault.afterJson?.(...args)
        },
    }
})

vi.mock('./portable-lock.js', async importOriginal => {
    const actual = await importOriginal<typeof import('./portable-lock.js')>()
    return {
        ...actual,
        removePortableQuarantinedDirectory: async (...args: Parameters<typeof actual.removePortableQuarantinedDirectory>) => {
            const path = `${args[0]}/${args[1]}`
            await fault.beforeRemove?.(path, true)
            await actual.removePortableQuarantinedDirectory(...args)
            await fault.afterRemove?.(path, true)
        },
    }
})

const roots: string[] = []
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>

beforeAll(async () => {
    helper = await prepareSkillHelperFixture()
    process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
})
afterEach(async () => {
    fault.afterJson = undefined
    fault.beforeRemove = undefined
    fault.afterRemove = undefined
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => {
    if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper
    await helper?.close()
})

async function fixture(config: Record<string, unknown> = { name: 'Recovery fixture' }) {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-recovery-')))
    roots.push(dataRoot)
    const bytes = Buffer.from(`${JSON.stringify(config)}\n`)
    const manifest = sealPortableManifest({
        format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,
        formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
        packageKey: 'b'.repeat(32), title: 'Recovery fixture', capturedAt: '2026-11-05T00:00:00.000Z',
        proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
        limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers: [{
            agentKey: 'c00', name: 'Recovery fixture', description: '',
            setup: { required: false, prompt: '', answered: true },
            members: [{ path: 'config.json', bytes: bytes.length, kind: 'config', contentDigest: sha256(bytes), flagged: [], binary: false, textScanned: true }],
            exclusions: [], redactions: [], strippedConfigKeys: [], requirements: [], envKeys: [], mcpAuth: [],
        }],
        fidelity: { binaryAssets: false, userSkillTrees: false, sourceKind: 'local-v1-export', notes: [] },
        excludedCategories: [],
    })
    const built = await writePortableArchive({
        title: manifest.title, packageKey: manifest.packageKey, manifest,
        members: [{ agentKey: 'c00', path: 'config.json', bytes, digest: sha256(bytes) }], startedAt: Date.now(),
    })
    await readPortableArchive(built.archiveBytes)
    const uploadId = randomUUID()
    const deps = {
        dataRoot,
        readImmutableUpload: async (id: string) => {
            if (id !== uploadId) throw new Error('Unexpected upload identity')
            return built.archiveBytes
        },
        publishDownloadArtifact: async () => { throw new Error('Recovery must not publish an export') },
    }
    const open = () => createDesktopPortableTemplateService(deps)
    const importOperation = { operation: 'import-package' as const, requestId: randomUUID(), uploadId }
    return { dataRoot, open, importOperation, manifest, deps }
}

test('a lost acknowledgement after import publication reopens the exact template and revision', async () => {
    const { dataRoot, open, importOperation, manifest } = await fixture()
    let interrupted = false
    fault.afterJson = async (_directory, name) => {
        if (name !== 'current.json' || interrupted) return
        interrupted = true
        throw new Error('Simulated process loss immediately after publication')
    }
    const first = await open().handle(importOperation)
    expect(interrupted).toBe(true)
    expect(first.status).toBe('uncertain')
    fault.afterJson = undefined
    const beforeIds = await listTemplateIds(dataRoot)
    expect(beforeIds).toHaveLength(1)
    const originalCurrent = await readOwnJson(templateHome(dataRoot, beforeIds[0]), 'current.json')

    const recovered = await open().handle(importOperation)
    expect(recovered).toMatchObject({ status: 'imported', templateId: beforeIds[0], revision: (originalCurrent as { revision: string }).revision, fidelity: manifest.fidelity })
    expect(await listTemplateIds(dataRoot)).toEqual(beforeIds)
    expect(await readdir(join(templateHome(dataRoot, beforeIds[0]), 'revisions'))).toEqual([(originalCurrent as { revision: string }).revision])
    expect(await open().handle(importOperation)).toEqual(recovered)
})

test('interruption during initial import allocation reuses the reserved library identity', async () => {
    const { dataRoot, open, importOperation } = await fixture()
    let allocatedId: string | undefined
    fault.afterJson = async (_directory, name, value) => {
        if (name !== 'draft.json' || allocatedId) return
        allocatedId = (value as { templateId: string }).templateId
        throw new Error('Simulated process loss after initial allocation')
    }
    const first = await open().handle(importOperation)
    expect(allocatedId).toBeDefined()
    expect(first.status).toBe('uncertain')
    fault.afterJson = undefined

    const recovered = await open().handle(importOperation)
    expect(recovered).toMatchObject({ status: 'imported', templateId: allocatedId })
    expect(await listTemplateIds(dataRoot)).toEqual([allocatedId])
    expect(await open().handle(importOperation)).toEqual(recovered)
})

test.each(['before removal', 'after removal'] as const)('delete resumes across restart %s and preserves an independent template', async stage => {
    const { dataRoot, open, importOperation } = await fixture()
    const target = await open().handle(importOperation)
    const sibling = await open().handle({ ...importOperation, requestId: randomUUID() })
    expect(target.status).toBe('imported')
    expect(sibling.status).toBe('imported')
    if (target.status !== 'imported' || sibling.status !== 'imported') throw new Error('Import fixture did not become ready')
    const siblingCurrent = await readOwnJson(templateHome(dataRoot, sibling.templateId), 'current.json')
    const siblingBytesPath = join(templateHome(dataRoot, sibling.templateId), 'revisions', sibling.revision, 'c00', 'config.json')
    const siblingBytes = await readFile(siblingBytesPath)
    const outsideArtifact = join(dataRoot, 'exported-copy.tar.gz')
    await writeFile(outsideArtifact, 'previously exported copy')
    const operation = { operation: 'delete' as const, requestId: randomUUID(), templateId: target.templateId, revision: target.revision }
    let interrupted = false
    const fail = async (path: string, recursive: boolean) => {
        if (!recursive || !path.startsWith(join(dataRoot, 'desktop-templates')) || interrupted) return
        interrupted = true
        throw new Error(`Simulated process loss ${stage}`)
    }
    if (stage === 'before removal') fault.beforeRemove = fail
    else fault.afterRemove = fail
    const first = await open().handle(operation)
    expect(interrupted).toBe(true)
    expect(first.status).toBe('uncertain')
    fault.beforeRemove = undefined
    fault.afterRemove = undefined

    const recovered = await open().handle(operation)
    expect(recovered).toMatchObject({ status: 'deleted', requestId: operation.requestId, templateId: target.templateId, revision: target.revision })
    expect(await open().handle(operation)).toEqual(recovered)
    expect(await open().receipt(operation.requestId)).toMatchObject({ status: 'deleted', recoverable: false, templateId: target.templateId })
    expect(await lstat(templateHome(dataRoot, target.templateId)).catch(() => null)).toBeNull()
    expect(await readOwnJson(templateHome(dataRoot, sibling.templateId), 'current.json')).toEqual(siblingCurrent)
    expect(await readFile(siblingBytesPath)).toEqual(siblingBytes)
    expect(await readFile(outsideArtifact, 'utf8')).toBe('previously exported copy')
})

test('concurrent copies of one import request recover the same reserved library entry', async () => {
    const { dataRoot, open, importOperation } = await fixture()
    const [first, second] = await Promise.all([open().handle(importOperation), open().handle(importOperation)])
    expect(first.status).toBe('imported')
    expect(second).toEqual(first)
    expect(await listTemplateIds(dataRoot)).toHaveLength(1)
})

test('portable import resets active model, tool, MCP and setup bindings using the original config scrubber', async () => {
    const { dataRoot, open, importOperation } = await fixture({
        name: 'Recovery fixture', provider: 'other-provider', model: 'expensive-model', connectionId: 'foreign-connection',
        tools: { bash: true, desktopToolGrants: { files: true }, desktopCodexGrants: { shell: true } },
        mcpServers: [{ name: 'active-server', command: 'sh', args: ['-c', 'never run'], headers: { authorization: 'private-token' } }],
        setup: { required: true, completedAt: 'yesterday', sessionId: 'foreign-session' },
    })
    const result = await open().handle(importOperation)
    if (result.status !== 'imported') throw new Error('Import did not finish')
    const config = JSON.parse(await readFile(join(templateHome(dataRoot, result.templateId), 'revisions', result.revision, 'c00', 'config.json'), 'utf8'))
    expect(config).toMatchObject({ connectionId: null, provider: null, model: null, mcpServers: [], setup: { completedAt: null, sessionId: null } })
    expect(Object.values(config.tools).every(value => value === false)).toBe(true)
    expect(JSON.stringify(config)).not.toContain('private-token')
    expect(JSON.stringify(config)).not.toContain('foreign-session')
})

test('an export stays uncertain until publication and recovers a lost publication response without publishing twice', async () => {
    const { open, importOperation, deps } = await fixture()
    const imported = await open().handle(importOperation)
    if (imported.status !== 'imported') throw new Error('Import did not finish')
    const operation = { operation: 'export' as const, requestId: randomUUID(), templateId: imported.templateId, revision: imported.revision }
    let artifact: { artifactId: string; contentDigest: string; fileName: string; bytes: number } | null = null
    const publish = vi.fn(async (bytes: Buffer, fileName: string, identity: import('./portable-export.js').PortableArtifactIdentity) => {
        expect(identity).toMatchObject({ requestId: operation.requestId, templateId: imported.templateId, revision: imported.revision })
        expect(await open().receipt(operation.requestId)).toMatchObject({ status: 'uncertain', artifactId: null, recoverable: true })
        artifact = { artifactId: 'e'.repeat(32), contentDigest: identity.contentDigest, fileName, bytes: bytes.length }
        throw new Error('Publication succeeded but its response was lost')
    })
    const reopen = () => createDesktopPortableTemplateService({ ...deps, publishDownloadArtifact: publish, findDownloadArtifact: async () => artifact })
    expect(await reopen().handle(operation)).toMatchObject({ status: 'uncertain' })
    const recovered = await reopen().handle(operation)
    expect(recovered).toMatchObject({ status: 'exported', artifactId: 'e'.repeat(32) })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await reopen().handle(operation)).toEqual(recovered)
    expect(await reopen().receipt(operation.requestId)).toMatchObject({ status: 'acknowledged', artifactId: 'e'.repeat(32), recoverable: false })
})
