import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DESKTOP_PORTABLE_TEMPLATE_LIMITS, desktopPortableArtifactIdSchema, desktopPortableUploadIdSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { readConfinedBytes, writeExclusiveFile, ensurePrivateDir } from './files.js'
import { canonicalJson, sha256 } from './hash.js'
import type { PortableArtifactIdentity } from './portable-export.js'
import { readOwnJson, requestHome, writeOwnJson } from './store.js'

const ownerSchema = z.strictObject({ installId: z.uuid(), workspaceId: z.literal(1) })
const fileNameSchema = z.string().min(1).max(180).refine(value => !/[\\/\p{Cc}]/u.test(value))
const storedSchema = z.strictObject({
    version: z.literal(1), owner: ownerSchema, fileName: fileNameSchema,
    bytes: z.number().int().min(24).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes),
    archiveDigest: desktopTemplateRevisionSchema,
})
const uploadSchema = storedSchema.extend({ uploadId: desktopPortableUploadIdSchema })
const artifactSchema = storedSchema.extend({ artifactId: desktopPortableArtifactIdSchema, requestId: z.uuid(),
    templateId: desktopPortableArtifactIdSchema, revision: desktopTemplateRevisionSchema, contentDigest: desktopTemplateRevisionSchema })

export async function initializeDesktopPortableFiles(dataRoot: string) {
    for (const name of ['uploads', 'artifacts']) await ensurePrivateDir(join(dataRoot, 'desktop-templates', 'portable-io', name))
}

export function createDesktopPortableFileStore(dataRoot: string) {
    const root = join(dataRoot, 'desktop-templates', 'portable-io')
    const currentOwner = async () => {
        const owner = ownerSchema.safeParse(await readOwnJson(dataRoot, 'desktop-owner.json'))
        if (!owner.success) throw new TemplateRequestError(503, 'Template file storage is not bound to this workspace')
        return owner.data
    }
    const assertOwner = async (record: z.infer<typeof storedSchema>) => {
        if (canonicalJson(record.owner) !== canonicalJson(await currentOwner())) throw new TemplateRequestError(409, 'This template file belongs to another workspace')
    }
    async function readBytes(directory: string, record: z.infer<typeof storedSchema>) {
        await assertOwner(record)
        const read = await readConfinedBytes(directory, 'archive.tar.gz', DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes)
        if (!read.ok || read.bytes.length !== record.bytes || read.contentRevision !== record.archiveDigest) throw new TemplateRequestError(409, 'Template file bytes no longer match their receipt')
        await assertOwner(record)
        return read.bytes
    }
    async function uploadRecord(uploadId: string) {
        if (!desktopPortableUploadIdSchema.safeParse(uploadId).success) throw new TemplateRequestError(400, 'Invalid template upload')
        const record = uploadSchema.safeParse(await readOwnJson(join(root, 'uploads', uploadId), 'record.json'))
        if (!record.success || record.data.uploadId !== uploadId) throw new TemplateRequestError(404, 'Template upload not found')
        await assertOwner(record.data)
        return record.data
    }
    async function artifactRecord(artifactId: string) {
        if (!desktopPortableArtifactIdSchema.safeParse(artifactId).success) throw new TemplateRequestError(400, 'Invalid template download')
        const raw = await readOwnJson(join(root, 'artifacts', artifactId), 'record.json')
        if (!raw) return null
        const record = artifactSchema.safeParse(raw)
        if (!record.success || record.data.artifactId !== artifactId) throw new TemplateRequestError(409, 'Template download receipt is invalid')
        await assertOwner(record.data)
        return record.data
    }
    const artifactIdOf = (identity: PortableArtifactIdentity) => sha256(canonicalJson(identity)).slice(0, 32)
    return {
        async upload(uploadId: string, bytes: Buffer, fileName: string) {
            const input = uploadSchema.safeParse({ version: 1, owner: await currentOwner(), uploadId, fileName, bytes: bytes.length, archiveDigest: sha256(bytes) })
            if (!input.success) throw new TemplateRequestError(400, 'Invalid template package upload')
            const record = input.data
            const directory = join(root, 'uploads', record.uploadId)
            const prior = await readOwnJson(directory, 'record.json')
            if (prior && canonicalJson(prior) !== canonicalJson(record)) throw new TemplateRequestError(409, 'This upload identity already belongs to other bytes')
            await ensurePrivateDir(directory)
            await writeExclusiveFile(directory, 'archive.tar.gz', bytes)
            await writeOwnJson(directory, 'record.json', record)
            await assertOwner(record)
            return { uploadId, fileName: record.fileName, bytes: record.bytes }
        },
        async uploadInfo(uploadId: string) {
            const record = await uploadRecord(uploadId)
            await readBytes(join(root, 'uploads', uploadId), record)
            return { uploadId, fileName: record.fileName, bytes: record.bytes }
        },
        async readImmutableUpload(uploadId: string) {
            const record = await uploadRecord(uploadId)
            return readBytes(join(root, 'uploads', uploadId), record)
        },
        async publishDownloadArtifact(bytes: Buffer, fileName: string, identity: PortableArtifactIdentity) {
            const artifactId = artifactIdOf(identity)
            const record = artifactSchema.parse({ version: 1, owner: await currentOwner(), ...identity, artifactId, fileName, bytes: bytes.length, archiveDigest: sha256(bytes) })
            const directory = join(root, 'artifacts', artifactId)
            const prior = await readOwnJson(directory, 'record.json')
            if (prior && canonicalJson(prior) !== canonicalJson(record)) throw new TemplateRequestError(409, 'This export identity already belongs to other bytes')
            await ensurePrivateDir(directory)
            await writeExclusiveFile(directory, 'archive.tar.gz', bytes)
            await writeOwnJson(directory, 'record.json', record)
            await assertOwner(record)
            return { artifactId }
        },
        async findDownloadArtifact(identity: PortableArtifactIdentity) {
            const artifactId = artifactIdOf(identity)
            const record = await artifactRecord(artifactId)
            if (!record) return null
            if (record.requestId !== identity.requestId || record.templateId !== identity.templateId || record.revision !== identity.revision || record.contentDigest !== identity.contentDigest) throw new TemplateRequestError(409, 'Template download belongs to another request')
            await readBytes(join(root, 'artifacts', artifactId), record)
            return { artifactId, contentDigest: record.contentDigest, fileName: record.fileName, bytes: record.bytes }
        },
        async downloadInfo(artifactId: string) {
            const record = await artifactRecord(artifactId)
            if (!record) throw new TemplateRequestError(404, 'Template download not found')
            return { artifactId, fileName: record.fileName, bytes: record.bytes, archiveDigest: record.archiveDigest }
        },
        async download(artifactId: string) {
            const record = await artifactRecord(artifactId)
            if (!record) throw new TemplateRequestError(404, 'Template download not found')
            return { record, bytes: await readBytes(join(root, 'artifacts', artifactId), record) }
        },
        async hasOwnedArtifactReference(input: { templateId: string; revision: string }) {
            const home = requestHome(dataRoot)
            const names = await readdir(home).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
            if (names.length > 20_000) throw new TemplateRequestError(503, 'Template receipt storage needs maintenance')
            for (const name of names) {
                if (!/^portable-export-[a-f0-9-]{36}\.json$/.test(name)) continue
                const raw = await readOwnJson(home, name)
                if (!raw || typeof raw !== 'object') throw new TemplateRequestError(409, 'A template export receipt cannot be read')
                const record = raw as Record<string, unknown>
                if (record.templateId === input.templateId && record.revision === input.revision && record.phase !== 'published') return true
            }
            return false
        },
    }
}
