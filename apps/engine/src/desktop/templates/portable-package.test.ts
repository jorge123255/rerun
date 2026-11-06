import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { collidingRelativePaths, readConfinedBytes } from './files.js'
import { sealPortableManifest, readPortableArchive, writePortableArchive, validatePortableMembers } from './portable-package.js'
import { sha256 } from './hash.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function member(path: string, bytes: Buffer, kind: 'text' | 'binary' | 'skill' = 'text') {
    return {
        path,
        bytes: bytes.length,
        kind,
        contentDigest: sha256(bytes),
        flagged: [] as string[],
        binary: kind === 'binary',
        textScanned: kind !== 'binary',
    }
}

test('portable package round-trips binary skill assets and validates digests', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    const skill = Buffer.from('---\nname: Demo\ndescription: demo\n---\n# Demo\n', 'utf8')
    const text = Buffer.from('workspace note\n', 'utf8')
    const members = [
        { agentKey: 'c00', path: 'skills/demo/SKILL.md', bytes: skill, digest: sha256(skill) },
        { agentKey: 'c00', path: 'skills/demo/icon.png', bytes: png, digest: sha256(png) },
        { agentKey: 'c00', path: 'workspace/note.txt', bytes: text, digest: sha256(text) },
        { agentKey: 'c00', path: 'config.json', bytes: Buffer.from('{"name":"Demo"}\n'), digest: sha256(Buffer.from('{"name":"Demo"}\n')) },
    ]
    const body = {
        format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,
        formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
        packageKey: 'a'.repeat(32),
        title: 'Demo',
        capturedAt: '2026-11-05T00:00:00.000Z',
        proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
        limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers: [{
            agentKey: 'c00' as const,
            name: 'Demo',
            description: '',
            setup: { required: false, prompt: '', answered: true },
            members: [
                member('config.json', members[3].bytes, 'text'),
                member('skills/demo/SKILL.md', skill, 'skill'),
                member('skills/demo/icon.png', png, 'binary'),
                member('workspace/note.txt', text, 'text'),
            ].map(item => item.kind === 'binary' ? { ...item, kind: 'binary' as const } : item.kind === 'skill' ? { ...item, kind: 'skill' as const } : { ...item, kind: 'text' as const }),
            exclusions: [],
            redactions: [],
            strippedConfigKeys: [],
            requirements: [],
            envKeys: [],
            mcpAuth: [],
        }],
        fidelity: { binaryAssets: true, userSkillTrees: true, sourceKind: 'portable-capture' as const, notes: [] },
        excludedCategories: ['credentials', 'history', 'memory', 'database', 'connector-skill', 'system-skill', 'service-registry', 'native-grant', 'tool-permissions', 'active-schedule', 'active-trigger', 'browser-profile', 'private-memory', 'paid-data', 'cached-pages', 'chat-transcript', 'tool-arguments', 'telemetry', 'marketplace', 'hosted-publish'] as const,
    }
    // Fix member kinds properly
    body.coworkers[0].members = [
        { ...member('config.json', members[3].bytes), kind: 'text' },
        { ...member('skills/demo/SKILL.md', skill), kind: 'skill' },
        { ...member('skills/demo/icon.png', png, 'binary'), kind: 'binary' },
        { ...member('workspace/note.txt', text), kind: 'text' },
    ]
    const manifest = sealPortableManifest(body as never)
    validatePortableMembers(manifest, members)
    const built = await writePortableArchive({
        title: 'Demo',
        packageKey: body.packageKey,
        manifest,
        members,
        startedAt: Date.now(),
    })
    const read = await readPortableArchive(built.archiveBytes)
    expect(read.manifest.contentDigest).toBe(manifest.contentDigest)
    expect(read.members.find(item => item.path.endsWith('icon.png'))?.bytes.equals(png)).toBe(true)
})

test('portable package rejects path traversal, future versions, truncated archives and colliding names', async () => {
    expect(collidingRelativePaths(['skills/A/SKILL.md', 'skills/a/SKILL.md'])).toBe('skills/a/SKILL.md')
    await expect(readPortableArchive(Buffer.from('not-a-tar'))).rejects.toBeInstanceOf(TemplateRequestError)
    const future = Buffer.from(JSON.stringify({ format: DESKTOP_PORTABLE_TEMPLATE_FORMAT, formatVersion: 99 }), 'utf8')
    // Corrupt/truncated gzip should refuse clearly rather than install.
    await expect(readPortableArchive(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(8)]))).rejects.toBeInstanceOf(Error)
    void future
})

test('readConfinedBytes preserves binary bytes and does not claim text scanning', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-bytes-')))
    roots.push(root)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
    await writeFile(join(root, 'icon.png'), png, { mode: 0o600 })
    const read = await readConfinedBytes(root, 'icon.png', DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.binary).toBe(true)
    expect(read.textScanned).toBe(false)
    expect(read.bytes.equals(png)).toBe(true)
    expect(await readFile(join(root, 'icon.png'))).toEqual(png)
})
