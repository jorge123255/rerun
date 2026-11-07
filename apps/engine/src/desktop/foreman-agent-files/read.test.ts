import { mkdtemp, mkdir, writeFile, link, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const location = vi.hoisted(() => ({ root: '' }))
vi.mock('../../config/paths.js', () => ({ dataDir: () => location.root }))
import { readCoworkerVisibleText, listCoworkerVisible, searchCoworkerVisibleText } from './read.js'

let root: string, workspace: string
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'foreman-file-read-')))
    location.root = root
    workspace = join(root, 'agents', 'target', 'workspace')
    await mkdir(join(workspace, 'docs'), { recursive: true })
    await writeFile(join(workspace, 'note.md'), 'ordinary visible note')
    await writeFile(join(workspace, 'docs', 'nested.txt'), 'nested visible note')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const signal = () => new AbortController().signal

test('production directory enumeration lists real files and searches nested text', async () => {
    expect(await listCoworkerVisible('target', '.', signal())).toEqual({ entries: [{ name: 'docs', directory: true }, { name: 'note.md', directory: false }], truncated: false })
    expect(await searchCoworkerVisibleText('target', '.', 'visible', 20, signal())).toContain('note.md:1:ordinary visible note')
    expect(await searchCoworkerVisibleText('target', '.', 'nested', 20, signal())).toContain('docs/nested.txt:1:nested visible note')
})

test('visible hardlink and symlink aliases never disclose hidden or sibling stores', async () => {
    const privatePath = join(root, 'agents', 'target', '.env')
    await writeFile(privatePath, 'FAKE_PRIVATE_SENTINEL')
    await link(privatePath, join(workspace, 'public.txt'))
    await symlink(privatePath, join(workspace, 'linked.txt'))
    await expect(readCoworkerVisibleText('target', 'public.txt', signal())).rejects.toThrow()
    await expect(readCoworkerVisibleText('target', 'linked.txt', signal())).rejects.toThrow()
    const listing = await listCoworkerVisible('target', '.', signal())
    expect(listing.entries.map(entry => entry.name)).not.toContain('public.txt')
    expect(listing.entries.map(entry => entry.name)).not.toContain('linked.txt')
    expect(await searchCoworkerVisibleText('target', '.', 'FAKE_PRIVATE_SENTINEL', 20, signal())).toBe('No matches.')
    expect(await readCoworkerVisibleText('target', 'note.md', signal())).toBe('ordinary visible note')
})

test('stopped reads and a symlinked workspace stay refused', async () => {
    await expect(readCoworkerVisibleText('target', 'note.md', AbortSignal.abort())).rejects.toThrow()
    await mkdir(join(root, 'elsewhere'))
    await mkdir(join(root, 'agents', 'other'))
    await symlink(join(root, 'elsewhere'), join(root, 'agents', 'other', 'workspace'))
    await expect(listCoworkerVisible('other', '.', signal())).rejects.toThrow()
})
