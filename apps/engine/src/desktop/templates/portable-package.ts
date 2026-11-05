import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { create } from 'tar'
import { extract as tarExtract } from 'tar'
import {
    DESKTOP_PORTABLE_COWORKER_PREFIX,
    DESKTOP_PORTABLE_MANIFEST_MEMBER,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    desktopPortablePackageManifestSchema,
    type DesktopPortableMember,
    type DesktopPortablePackageManifest,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { collidingRelativePaths } from './files.js'
import { canonicalJson, sha256 } from './hash.js'

export type PortablePackageMemberBytes = {
    agentKey: string
    path: string
    bytes: Buffer
    digest: string
}

export type BuiltPortablePackage = {
    manifest: DesktopPortablePackageManifest
    archiveBytes: Buffer
    contentDigest: string
    fileName: string
}

function memberArchivePath(agentKey: string, path: string): string {
    return `${DESKTOP_PORTABLE_COWORKER_PREFIX}${agentKey}/${path}`
}

export function portableContentDigest(manifestBody: Omit<DesktopPortablePackageManifest, 'contentDigest'>): string {
    return sha256(canonicalJson(manifestBody))
}

export function sealPortableManifest(body: Omit<DesktopPortablePackageManifest, 'contentDigest'>): DesktopPortablePackageManifest {
    const contentDigest = portableContentDigest(body)
    return desktopPortablePackageManifestSchema.parse({ ...body, contentDigest })
}

export function validatePortableMembers(manifest: DesktopPortablePackageManifest, members: PortablePackageMemberBytes[]): void {
    const expected = new Map<string, DesktopPortableMember>()
    const paths: string[] = []
    let total = 0
    let count = 0
    for (const coworker of manifest.coworkers) {
        for (const member of coworker.members) {
            const key = `${coworker.agentKey}:${member.path}`
            if (expected.has(key)) throw new TemplateRequestError(409, 'Portable package repeats a member path')
            expected.set(key, member)
            paths.push(`${coworker.agentKey}/${member.path}`)
            total += member.bytes
            count += 1
        }
    }
    const collision = collidingRelativePaths(paths)
    if (collision) throw new TemplateRequestError(409, 'Portable package has a colliding member path')
    if (count > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles || total > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTotalBytes) {
        throw new TemplateRequestError(413, 'Portable package exceeds archive limits')
    }
    if (members.length !== expected.size) throw new TemplateRequestError(409, 'Portable package members do not match the manifest')
    for (const member of members) {
        const key = `${member.agentKey}:${member.path}`
        const meta = expected.get(key)
        if (!meta) throw new TemplateRequestError(409, 'Portable package contains an unexpected member')
        if (member.bytes.length !== meta.bytes || member.digest !== meta.contentDigest || sha256(member.bytes) !== meta.contentDigest) {
            throw new TemplateRequestError(409, 'Portable package member digest does not match')
        }
        expected.delete(key)
    }
    if (expected.size > 0) throw new TemplateRequestError(409, 'Portable package is missing declared members')
}

export async function writePortableArchive(input: {
    title: string
    packageKey: string
    manifest: DesktopPortablePackageManifest
    members: PortablePackageMemberBytes[]
    startedAt: number
}): Promise<BuiltPortablePackage> {
    validatePortableMembers(input.manifest, input.members)
    if (Date.now() - input.startedAt > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxElapsedMs) {
        throw new TemplateRequestError(413, 'Portable export exceeded the time bound')
    }
    const staging = await mkdtemp(join(tmpdir(), 'desktop-portable-export-'))
    const archivePath = join(staging, 'package.tar.gz')
    try {
        await writeFile(join(staging, DESKTOP_PORTABLE_MANIFEST_MEMBER), `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 })
        for (const member of input.members) {
            const relative = memberArchivePath(member.agentKey, member.path)
            const full = join(staging, relative)
            const parent = join(full, '..')
            await writeFile(join(staging, '.keep'), '', { flag: 'a' }).catch(() => undefined)
            const { mkdir } = await import('node:fs/promises')
            await mkdir(parent, { recursive: true, mode: 0o700 })
            await writeFile(full, member.bytes, { mode: 0o600 })
        }
        const entries = [DESKTOP_PORTABLE_MANIFEST_MEMBER, ...input.members.map(member => memberArchivePath(member.agentKey, member.path))]
        await create({ gzip: true, cwd: staging, portable: true, file: archivePath, noMtime: true }, entries)
        const info = await stat(archivePath)
        if (info.size > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes) {
            throw new TemplateRequestError(413, 'Portable export exceeds the compressed size bound')
        }
        if (Date.now() - input.startedAt > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxElapsedMs) {
            throw new TemplateRequestError(413, 'Portable export exceeded the time bound')
        }
        const archiveBytes = await readFile(archivePath)
        const safeTitle = input.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'template'
        return {
            manifest: input.manifest,
            archiveBytes,
            contentDigest: input.manifest.contentDigest,
            fileName: `${safeTitle}-${input.packageKey.slice(0, 8)}.portable.tar.gz`,
        }
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
}

export async function readPortableArchive(archiveBytes: Buffer, startedAt = Date.now()): Promise<{
    manifest: DesktopPortablePackageManifest
    members: PortablePackageMemberBytes[]
}> {
    if (archiveBytes.length > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes) {
        throw new TemplateRequestError(413, 'Portable package exceeds the compressed size bound')
    }
    const staging = await mkdtemp(join(tmpdir(), 'desktop-portable-import-'))
    const archivePath = join(staging, 'upload.tar.gz')
    try {
        await writeFile(archivePath, archiveBytes, { mode: 0o600 })
        let compressedSeen = 0
        let memberCount = 0
        let totalBytes = 0
        const extracted = new Map<string, Buffer>()
        await tarExtract({
            file: archivePath,
            cwd: staging,
            strict: true,
            preservePaths: false,
            onentry(entry) {
                compressedSeen += 1
                if (compressedSeen > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxMembers) {
                    entry.resume()
                    throw new TemplateRequestError(413, 'Portable package has too many members')
                }
                const name = entry.path.replace(/^\.\//, '')
                if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..')) {
                    entry.resume()
                    throw new TemplateRequestError(400, 'Portable package path is not confined')
                }
                if (entry.type === 'SymbolicLink' || entry.type === 'Link' || entry.type === 'BlockDevice' || entry.type === 'CharacterDevice' || entry.type === 'FIFO') {
                    entry.resume()
                    throw new TemplateRequestError(400, 'Portable package contains an unsafe member type')
                }
                if (typeof entry.size === 'number' && entry.size > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes) {
                    entry.resume()
                    throw new TemplateRequestError(413, 'Portable package member exceeds the per-file bound')
                }
            },
            filter(path, entry) {
                const name = path.replace(/^\.\//, '')
                if (entry.type === 'Directory') return true
                if (name !== DESKTOP_PORTABLE_MANIFEST_MEMBER && !name.startsWith(DESKTOP_PORTABLE_COWORKER_PREFIX)) {
                    throw new TemplateRequestError(400, 'Portable package contains an unexpected member')
                }
                return true
            },
        })
        if (Date.now() - startedAt > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxElapsedMs) {
            throw new TemplateRequestError(413, 'Portable import exceeded the time bound')
        }
        const manifestRaw = await readFile(join(staging, DESKTOP_PORTABLE_MANIFEST_MEMBER), 'utf8').catch(() => {
            throw new TemplateRequestError(400, 'Portable package is missing its manifest')
        })
        let parsed: unknown
        try { parsed = JSON.parse(manifestRaw) } catch { throw new TemplateRequestError(400, 'Portable package manifest is not JSON') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TemplateRequestError(400, 'Portable package manifest is invalid')
        const record = parsed as Record<string, unknown>
        if (record.format !== DESKTOP_PORTABLE_TEMPLATE_FORMAT) throw new TemplateRequestError(400, 'This file is not a desktop portable template package')
        if (record.formatVersion !== DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION) {
            throw new TemplateRequestError(400, `Unsupported portable template format version ${String(record.formatVersion)}`)
        }
        const manifest = desktopPortablePackageManifestSchema.safeParse(parsed)
        if (!manifest.success) throw new TemplateRequestError(400, 'Portable package manifest failed validation')
        const body = { ...manifest.data }
        const digest = body.contentDigest
        const withoutDigest = { ...body }
        delete (withoutDigest as { contentDigest?: string }).contentDigest
        if (portableContentDigest(withoutDigest as Omit<DesktopPortablePackageManifest, 'contentDigest'>) !== digest) {
            throw new TemplateRequestError(409, 'Portable package content digest does not match')
        }
        const members: PortablePackageMemberBytes[] = []
        for (const coworker of manifest.data.coworkers) {
            for (const member of coworker.members) {
                const relative = memberArchivePath(coworker.agentKey, member.path)
                const bytes = await readFile(join(staging, relative)).catch(() => {
                    throw new TemplateRequestError(409, 'Portable package is missing a declared member')
                })
                totalBytes += bytes.length
                memberCount += 1
                if (memberCount > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles || totalBytes > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTotalBytes) {
                    throw new TemplateRequestError(413, 'Portable package exceeds archive limits')
                }
                if (bytes.length !== member.bytes || sha256(bytes) !== member.contentDigest) {
                    throw new TemplateRequestError(409, 'Portable package member digest does not match')
                }
                extracted.set(`${coworker.agentKey}:${member.path}`, bytes)
                members.push({ agentKey: coworker.agentKey, path: member.path, bytes, digest: member.contentDigest })
            }
        }
        // Reject undeclared coworker files that survived the filter.
        validatePortableMembers(manifest.data, members)
        return { manifest: manifest.data, members }
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
}

export async function readImmutableUploadBytes(read: () => Promise<Buffer>, maxBytes = DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes): Promise<Buffer> {
    const bytes = await read()
    if (!Buffer.isBuffer(bytes)) throw new TemplateRequestError(400, 'Portable upload is not immutable bytes')
    if (bytes.length < 24) throw new TemplateRequestError(400, 'Portable upload is truncated')
    if (bytes.length > maxBytes) throw new TemplateRequestError(413, 'Portable upload exceeds the compressed size bound')
    return bytes
}

export async function writeOwnedDownloadArtifact(write: (bytes: Buffer, fileName: string) => Promise<{ artifactId: string }>, built: BuiltPortablePackage): Promise<{ artifactId: string; fileName: string; bytes: number }> {
    const result = await write(built.archiveBytes, built.fileName)
    if (!/^[a-f0-9]{32}$/.test(result.artifactId)) throw new TemplateRequestError(503, 'Download artifact callback returned an invalid id')
    return { artifactId: result.artifactId, fileName: built.fileName, bytes: built.archiveBytes.length }
}

// Keep stream helpers available for root-owned download/upload bridges.
export async function copyBoundedFile(source: string, destination: string, maxBytes: number): Promise<number> {
    const handle = await open(source, 'r')
    try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > maxBytes) throw new TemplateRequestError(413, 'File exceeds the portable bound')
        await finished(createReadStream(source).pipe(createWriteStream(destination, { mode: 0o600 })))
        return info.size
    } finally {
        await handle.close()
    }
}
