import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { create, Header, Parser, type ReadEntry } from 'tar'
import {
    DESKTOP_PORTABLE_COWORKER_PREFIX,
    DESKTOP_PORTABLE_MANIFEST_MEMBER,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    desktopTemplateFidelityManifestSchema as desktopPortablePackageManifestSchema,
    isDesktopTemplateRelativePath,
    type DesktopTemplateFidelityMember as DesktopPortableMember,
    type DesktopTemplateFidelityManifest as DesktopPortablePackageManifest,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.ts'
import { collidingRelativePaths, readConfinedBytes, writeExclusiveFile } from './files.ts'
import { canonicalJson, sha256 } from './hash.ts'

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
    const coworkers = new Set<string>()
    let total = 0
    let count = 0
    for (const coworker of manifest.coworkers) {
        if (coworkers.has(coworker.agentKey)) throw new TemplateRequestError(409, 'Portable package repeats a coworker')
        coworkers.add(coworker.agentKey)
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
    // These paths exist only in the OS temporary directory during an explicit export.
    const staging = await mkdtemp(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ tmpdir(), 'desktop-portable-export-'))
    const archivePath = join(/* turbopackIgnore: true */ staging, 'package.tar.gz')
    try {
        await writeFile(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ staging, DESKTOP_PORTABLE_MANIFEST_MEMBER), `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 })
        for (const member of [...input.members].sort((a,b) => memberArchivePath(a.agentKey, a.path).localeCompare(memberArchivePath(b.agentKey, b.path), 'en'))) {
            const relative = memberArchivePath(member.agentKey, member.path)
            const full = join(/* turbopackIgnore: true */ staging, relative)
            const parent = join(/* turbopackIgnore: true */ full, '..')
            await writeFile(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ staging, '.keep'), '', { flag: 'a' }).catch(() => undefined)
            const { mkdir } = await import('node:fs/promises')
            await mkdir(/* turbopackIgnore: true */ parent, { recursive: true, mode: 0o700 })
            await writeFile(/* turbopackIgnore: true */ full, member.bytes, { mode: 0o600 })
        }
        const entries = [DESKTOP_PORTABLE_MANIFEST_MEMBER, ...input.members.map(member => memberArchivePath(member.agentKey, member.path)).sort()]
        await create({ gzip: true, cwd: /* turbopackIgnore: true */ staging, portable: true, file: /* turbopackIgnore: true */ archivePath, noMtime: true }, entries)
        const info = await stat(/* turbopackIgnore: true */ archivePath)
        if (info.size > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes) {
            throw new TemplateRequestError(413, 'Portable export exceeds the compressed size bound')
        }
        if (Date.now() - input.startedAt > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxElapsedMs) {
            throw new TemplateRequestError(413, 'Portable export exceeded the time bound')
        }
        const archiveBytes = await readFile(/* turbopackIgnore: true */ archivePath)
        const safeTitle = input.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'template'
        return {
            manifest: input.manifest,
            archiveBytes,
            contentDigest: input.manifest.contentDigest,
            fileName: `${safeTitle}-${input.packageKey.slice(0, 8)}.portable.tar.gz`,
        }
    } finally {
        await rm(/* turbopackIgnore: true */ staging, { recursive: true, force: true })
    }
}

export async function readPortableArchive(archiveBytes: Buffer, startedAt = Date.now()): Promise<{
    manifest: DesktopPortablePackageManifest
    members: PortablePackageMemberBytes[]
}> {
    const limits = DESKTOP_PORTABLE_TEMPLATE_LIMITS
    if (archiveBytes.length > limits.maxCompressedBytes) throw new TemplateRequestError(413, 'Portable package exceeds the compressed size bound')
    if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) throw new TemplateRequestError(400, 'Portable package is not a gzip archive')
    const remaining = limits.maxElapsedMs - (Date.now() - startedAt)
    if (remaining <= 0) throw new TemplateRequestError(413, 'Portable import exceeded the time bound')
    const inventory = new Map<string, Buffer>()
    const names = new Map<string, { name: string; directory: boolean }>()
    let refusal: TemplateRequestError | null = null
    let declaredBytes = 0
    let memberBytes = 0
    let headers = 0
    let expandedBytes = 0
    let nullBlocks = 0
    let bodyRemaining = 0
    let headerBytes = Buffer.alloc(0)
    const refuse = (status: 400 | 409 | 413, message: string) => {
        refusal ??= new TemplateRequestError(status, message)
        return false
    }
    const parser = new Parser({
        strict: true,
        maxMetaEntrySize: 64 * 1024,
        filter(path, entry) {
            if (refusal) return false
            const type = 'type' in entry ? entry.type : 'File'
            const directory = type === 'Directory'
            if (!directory && type !== 'File') return refuse(400, 'Portable package contains an unsafe member type')
            const name = path.replace(/^(?:\.\/)+/, '').replace(directory ? /\/+$/ : /$^/, '')
            if (!isDesktopTemplateRelativePath(name)) return refuse(400, 'Portable package path is not confined')
            if (directory ? name !== 'coworkers' && !name.startsWith(DESKTOP_PORTABLE_COWORKER_PREFIX)
                : name !== DESKTOP_PORTABLE_MANIFEST_MEMBER && !name.startsWith(DESKTOP_PORTABLE_COWORKER_PREFIX)) {
                return refuse(400, 'Portable package contains an unexpected member')
            }
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes || directory && entry.size !== 0) return refuse(413, 'Portable package member exceeds the per-file bound')
            if (!directory && name !== DESKTOP_PORTABLE_MANIFEST_MEMBER) {
                memberBytes += entry.size
                if (memberBytes > limits.maxTotalBytes) return refuse(413, 'Portable package exceeds archive limits')
            }
            const folded = name.normalize('NFKC').toLowerCase()
            if (names.has(folded)) return refuse(409, 'Portable package repeats a member path')
            for (const [key, previous] of names) {
                if ((!previous.directory && folded.startsWith(`${key}/`)) || (!directory && key.startsWith(`${folded}/`))) return refuse(409, 'Portable package has a colliding member path')
                const parts = name.split('/'), priorParts = previous.name.split('/')
                for (let i = 0; i < Math.min(parts.length, priorParts.length); i += 1) {
                    if (parts[i]!.normalize('NFKC').toLowerCase() !== priorParts[i]!.normalize('NFKC').toLowerCase()) break
                    if (parts[i] !== priorParts[i]) return refuse(409, 'Portable package has a colliding member path')
                }
            }
            names.set(folded, { name, directory })
            if (!directory && inventory.size >= limits.maxFiles + 1) return refuse(413, 'Portable package has too many files')
            return true
        },
    })
    let parserError: Error | null = null
    parser.on('error', (error: Error) => { parserError ??= error })
    parser.on('entry', (entry: ReadEntry) => {
        if (entry.type === 'Directory') { entry.resume(); return }
        const name = entry.path.replace(/^(?:\.\/)+/, '')
        const chunks: Buffer[] = []
        let bytes = 0
        entry.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > entry.size || bytes > limits.maxFileBytes) { refuse(413, 'Portable package member exceeds the per-file bound'); return }
            if (!refusal) chunks.push(chunk)
        })
        entry.on('end', () => {
            if (bytes !== entry.size) refuse(400, 'Portable package member is truncated')
            if (!refusal) inventory.set(name, Buffer.concat(chunks, bytes))
        })
        entry.resume()
    })
    // Inspect physical headers before handing expanded bytes to tar. This also bounds
    // metadata and ignored headers, which tar does not pass through its entry filter.
    const guard = (chunk: Buffer) => {
        expandedBytes += chunk.length
        if (expandedBytes > limits.maxTotalBytes + limits.maxFileBytes + (limits.maxMembers + 2) * 1024) throw new TemplateRequestError(413, 'Portable package exceeds archive limits')
        let offset = 0
        while (offset < chunk.length) {
            if (bodyRemaining > 0) {
                const bytes = Math.min(bodyRemaining, chunk.length - offset)
                bodyRemaining -= bytes; offset += bytes
                continue
            }
            const bytes = Math.min(512 - headerBytes.length, chunk.length - offset)
            headerBytes = Buffer.concat([headerBytes, chunk.subarray(offset, offset + bytes)])
            offset += bytes
            if (headerBytes.length !== 512) continue
            const header = new Header(headerBytes)
            headerBytes = Buffer.alloc(0)
            if (header.nullBlock) { nullBlocks += 1; continue }
            if (nullBlocks >= 2) throw new TemplateRequestError(400, 'Portable package contains data after its end')
            nullBlocks = 0
            if (!header.cksumValid) throw new TemplateRequestError(400, 'Portable package has an invalid header')
            headers += 1
            if (headers > limits.maxMembers) throw new TemplateRequestError(413, 'Portable package has too many members')
            const size = header.size ?? 0
            if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) throw new TemplateRequestError(413, 'Portable package member exceeds the per-file bound')
            declaredBytes += size
            if (declaredBytes > limits.maxTotalBytes + limits.maxFileBytes) throw new TemplateRequestError(413, 'Portable package exceeds archive limits')
            bodyRemaining = Math.ceil(size / 512) * 512
        }
    }
    const source = Readable.from([archiveBytes])
    const gunzip = createGunzip()
    const timeout = setTimeout(() => gunzip.destroy(new TemplateRequestError(413, 'Portable import exceeded the time bound')), remaining)
    try {
        source.pipe(gunzip)
        for await (const raw of gunzip) {
            if (Date.now() - startedAt > limits.maxElapsedMs) throw new TemplateRequestError(413, 'Portable import exceeded the time bound')
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
            guard(chunk)
            parser.write(chunk)
            if (refusal) throw refusal
            if (parserError) throw parserError
        }
        parser.end()
        if (refusal) throw refusal
        if (parserError) throw parserError
        if (bodyRemaining || headerBytes.length) throw new TemplateRequestError(400, 'Portable package is truncated')
    } catch (error) {
        throw error instanceof TemplateRequestError ? error : new TemplateRequestError(400, 'Portable package could not be read')
    } finally {
        clearTimeout(timeout)
        source.destroy()
        gunzip.destroy()
    }
    const manifestBytes = inventory.get(DESKTOP_PORTABLE_MANIFEST_MEMBER)
    if (!manifestBytes) throw new TemplateRequestError(400, 'Portable package is missing its manifest')
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) }
    catch { throw new TemplateRequestError(400, 'Portable package manifest is not JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TemplateRequestError(400, 'Portable package manifest is invalid')
    const record = parsed as Record<string, unknown>
    if (record.format !== DESKTOP_PORTABLE_TEMPLATE_FORMAT) throw new TemplateRequestError(400, 'This file is not a desktop portable template package')
    if (record.formatVersion !== DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION) throw new TemplateRequestError(400, 'Unsupported portable template format version')
    const manifest = desktopPortablePackageManifestSchema.safeParse(parsed)
    if (!manifest.success) throw new TemplateRequestError(400, 'Portable package manifest failed validation')
    const { contentDigest, ...body } = manifest.data
    if (portableContentDigest(body) !== contentDigest) throw new TemplateRequestError(409, 'Portable package content digest does not match')
    const members: PortablePackageMemberBytes[] = []
    for (const [name, bytes] of inventory) {
        if (name === DESKTOP_PORTABLE_MANIFEST_MEMBER) continue
        const match = /^coworkers\/(c[0-9]{2})\/(.+)$/.exec(name)
        if (!match) throw new TemplateRequestError(409, 'Portable package contains an unexpected member')
        members.push({ agentKey: match[1]!, path: match[2]!, bytes, digest: sha256(bytes) })
    }
    for (const { name, directory } of names.values()) {
        if (directory && ![...inventory.keys()].some(file => file.startsWith(`${name}/`))) throw new TemplateRequestError(409, 'Portable package contains an undeclared directory')
    }
    validatePortableMembers(manifest.data, members)
    if (Date.now() - startedAt > limits.maxElapsedMs) throw new TemplateRequestError(413, 'Portable import exceeded the time bound')
    return { manifest: manifest.data, members }
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

// Root supplies private artifact paths; capture and renderer APIs never accept them.
export async function copyBoundedFile(source: string, destination: string, maxBytes: number): Promise<number> {
    const read = await readConfinedBytes(dirname(source), basename(source), maxBytes)
    if (!read.ok) throw new TemplateRequestError(409, 'Portable copy requires unchanged owned bytes')
    await writeExclusiveFile(dirname(destination), basename(destination), read.bytes)
    return read.bytes.length
}
