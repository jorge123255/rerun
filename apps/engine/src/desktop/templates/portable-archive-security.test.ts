import { gzipSync } from 'node:zlib'
import { beforeEach, expect, test, vi } from 'vitest'
import {
    DESKTOP_PORTABLE_COWORKER_PREFIX,
    DESKTOP_PORTABLE_MANIFEST_MEMBER,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
} from '@rerun/contracts'
import { sha256 } from './hash.js'
import { readPortableArchive, sealPortableManifest } from './portable-package.js'

const observation = vi.hoisted(() => ({ expandedBytes: 0 }))
const expansionCeiling = 16 * 1024

vi.mock('@rerun/contracts', async importOriginal => {
    const actual = await importOriginal<typeof import('@rerun/contracts')>()
    return {
        ...actual,
        DESKTOP_PORTABLE_TEMPLATE_LIMITS: { ...actual.DESKTOP_PORTABLE_TEMPLATE_LIMITS, maxTotalBytes: 16 * 1024 },
    }
})

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    async function bytesIn(directory: string): Promise<number> {
        const entries = await actual.readdir(directory, { withFileTypes: true }).catch(() => [])
        let bytes = 0
        for (const entry of entries) {
            const path = `${directory}/${entry.name}`
            if (entry.isDirectory()) bytes += await bytesIn(path)
            else if (entry.isFile()) bytes += (await actual.stat(path)).size
        }
        return bytes
    }
    return {
        ...actual,
        rm: async (...args: Parameters<typeof actual.rm>) => {
            const directory = String(args[0])
            if (directory.includes('desktop-portable-import-') && args[1]?.recursive) {
                observation.expandedBytes = Math.max(observation.expandedBytes, await bytesIn(`${directory}/coworkers`))
            }
            return actual.rm(...args)
        },
    }
})

beforeEach(() => { observation.expandedBytes = 0 })

type Entry = { name: string; bytes: Buffer }

function tarGzip(entries: Entry[]): Buffer {
    const chunks: Buffer[] = []
    for (const entry of entries) {
        const header = Buffer.alloc(512)
        header.write(entry.name, 0, 100, 'utf8')
        header.write('0000600\0', 100, 8, 'ascii')
        header.write('0000000\0', 108, 8, 'ascii')
        header.write('0000000\0', 116, 8, 'ascii')
        header.write(`${entry.bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
        header.write('00000000000\0', 136, 12, 'ascii')
        header.fill(0x20, 148, 156)
        header.write('0', 156, 1, 'ascii')
        header.write('ustar\0', 257, 6, 'ascii')
        header.write('00', 263, 2, 'ascii')
        const checksum = header.reduce((sum, byte) => sum + byte, 0)
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
        chunks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512))
    }
    return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

async function packageEntries(files: Array<{ path: string; bytes: Buffer }> = [{ path: 'config.json', bytes: Buffer.from('{"name":"Archive fixture"}\n') }]): Promise<Entry[]> {
    // Keep the serialized format's real limits; only the reader's runtime ceiling is reduced.
    const actual = await vi.importActual<typeof import('@rerun/contracts')>('@rerun/contracts')
    const manifest = sealPortableManifest({
        format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,
        formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
        packageKey: 'a'.repeat(32),
        title: 'Archive fixture',
        capturedAt: '2026-11-05T00:00:00.000Z',
        proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
        limits: actual.DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers: [{
            agentKey: 'c00', name: 'Archive fixture', description: '',
            setup: { required: false, prompt: '', answered: false },
            members: files.map(file => ({
                path: file.path, bytes: file.bytes.length, kind: 'text',
                contentDigest: sha256(file.bytes), flagged: [], binary: false, textScanned: true,
            })),
            exclusions: [], redactions: [], strippedConfigKeys: [], requirements: [], envKeys: [], mcpAuth: [],
        }],
        fidelity: { binaryAssets: false, userSkillTrees: false, sourceKind: 'local-v1-export', notes: [] },
        excludedCategories: [],
    })
    return [
        { name: DESKTOP_PORTABLE_MANIFEST_MEMBER, bytes: Buffer.from(JSON.stringify(manifest)) },
        ...files.map(file => ({ name: `${DESKTOP_PORTABLE_COWORKER_PREFIX}c00/${file.path}`, bytes: file.bytes })),
    ]
}

test('a valid manually encoded portable archive still opens', async () => {
    const entries = await packageEntries()
    const result = await readPortableArchive(tarGzip(entries))
    expect(result.members).toHaveLength(1)
    expect(result.members[0].bytes).toEqual(entries[1].bytes)
})

test('compressed expansion is refused before more than the aggregate ceiling reaches disk', async () => {
    const entries = await packageEntries([
        { path: 'config.json', bytes: Buffer.from('{"name":"Expansion fixture"}\n') },
        ...Array.from({ length: 3 }, (_, index) => ({ path: `workspace/large-${index}.txt`, bytes: Buffer.alloc(8 * 1024, 0x61 + index) })),
    ])
    const archive = tarGzip(entries)
    expect(archive.length).toBeLessThan(expansionCeiling)
    await expect(readPortableArchive(archive)).rejects.toMatchObject({ status: 413 })
    expect(observation.expandedBytes).toBeLessThanOrEqual(expansionCeiling)
})

test('a valid manifest cannot conceal an undeclared coworker file', async () => {
    const entries = await packageEntries()
    entries.push({ name: `${DESKTOP_PORTABLE_COWORKER_PREFIX}c00/workspace/unlisted.txt`, bytes: Buffer.from('not declared') })
    await expect(readPortableArchive(tarGzip(entries))).rejects.toMatchObject({ status: expect.any(Number) })
})

test.each(['same spelling', 'dot prefix'] as const)('duplicate file entries are refused even when the last bytes match the manifest: %s', async spelling => {
    const entries = await packageEntries()
    const declared = entries[1]
    const hidden = { name: spelling === 'dot prefix' ? `./${declared.name}` : declared.name, bytes: Buffer.from('overwritten untrusted contents') }
    await expect(readPortableArchive(tarGzip([entries[0], hidden, declared]))).rejects.toMatchObject({ status: expect.any(Number) })
})

test('duplicate manifest entries are refused even when both copies are valid', async () => {
    const entries = await packageEntries()
    await expect(readPortableArchive(tarGzip([entries[0], ...entries]))).rejects.toMatchObject({ status: expect.any(Number) })
})
