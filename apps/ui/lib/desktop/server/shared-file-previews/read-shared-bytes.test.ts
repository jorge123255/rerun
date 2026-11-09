import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { readSharedBytes } from './read-shared-bytes'
import { onePixelPng } from './test-helpers'

let root: string
const runtime = () => ({ dataRoot: root, workspaceId: 1 }) as DesktopRuntime

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-shared-preview-bytes-'))
    await mkdir(join(root, 'workspaces', '1', 'engine', 'shared', 'nested'), { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('confined shared media bytes', () => {
    it('returns exact bytes and a content hash for an ordinary hidden image', async () => {
        const bytes = onePixelPng()
        await writeFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', '.preview.png'), bytes)
        const result = await readSharedBytes(runtime(), 'nested/.preview.png', 'image')
        expect(Buffer.from(result.bytes).equals(bytes)).toBe(true)
        expect(result.contentType).toBe('image/png')
        expect(result.identity).toBe(createHash('sha256').update(bytes).digest('hex'))
    })

    it('reads text and PDF bytes without confusing their media types', async () => {
        await writeFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'note.md'), '# shared')
        await writeFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'doc.pdf'), '%PDF-1.4\n1 0 obj\nendobj\n%%EOF')
        expect((await readSharedBytes(runtime(), 'nested/note.md', 'download')).contentType).toBe('application/octet-stream')
        expect((await readSharedBytes(runtime(), 'nested/doc.pdf', 'pdf')).contentType).toBe('application/pdf')
    })

    it('refuses reserved internal aliases, symlinks, hard links and private paths', async () => {
        const privateFile = join(root, 'workspaces', '1', 'engine', 'agents', 'alice', 'workspace', 'secret.txt')
        await mkdir(join(privateFile, '..'), { recursive: true })
        await writeFile(privateFile, 'private-only')
        const shared = join(root, 'workspaces', '1', 'engine', 'shared')
        await symlink(privateFile, join(shared, 'linked.png'))
        await link(privateFile, join(shared, 'alias.png'))
        await writeFile(join(shared, '.rerun-backup-old'), 'internal')
        await writeFile(join(shared, '.rerun'), 'internal')
        for (const path of ['.rerun', '.rerun-backup-old', 'nested/.rerun-skill-old/file.png', 'linked.png', 'alias.png', '../agents/alice/workspace/secret.txt']) {
            await expect(readSharedBytes(runtime(), path, 'download')).rejects.toThrow()
        }
    })

    it('detects a replaced inode rather than saving different bytes under the same name', async () => {
        const target = join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'doc.pdf')
        await writeFile(target, '%PDF-1.4\n1 0 obj\nendobj\n%%EOF')
        const pending = readSharedBytes(runtime(), 'nested/doc.pdf', 'pdf', { beforeCommit: async () => { await rename(target, `${target}.old`) } })
        await expect(pending).rejects.toThrow()
    })
})
