import { open, readFile, writeFile, readdir, mkdir, rm, rename } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import matter from 'gray-matter'
import { agentDir, pathSegment } from '../config/paths.js'
import { newId, nowIso } from '../lib/ids.js'

export type MemoryFile = {
    id: string
    kind: string
    tags: string[]
    createdAt: string
    updatedAt?: string
    content: string
    path: string
}

const memoryDir = (agentId: string) => resolve(agentDir(agentId), 'memory')

const memoryPath = (agentId: string, id: string) => resolve(memoryDir(agentId), `${pathSegment(id, 'memory id')}.md`)

export const memoryFileExists = (agentId: string, id: string): boolean => existsSync(memoryPath(agentId, id))

export async function writeMemoryFile(agentId: string, content: string, kind = 'note', tags: string[] = []): Promise<MemoryFile> {
    const id = newId()
    const createdAt = nowIso()
    await mkdir(memoryDir(agentId), { recursive: true })
    const path = memoryPath(agentId, id)
    await writeFile(path, matter.stringify(`\n${content.trim()}\n`, { id, kind, tags, createdAt }), 'utf8')
    return { id, kind, tags, createdAt, content: content.trim(), path }
}

export async function updateMemoryFile(agentId: string, id: string, content: string): Promise<MemoryFile> {
    const path = memoryPath(agentId, id)
    const existing = await readMemoryFile(path)
    const updatedAt = nowIso()
    await writeFile(path, matter.stringify(`\n${content.trim()}\n`, { id, kind: existing.kind, tags: existing.tags, createdAt: existing.createdAt, updatedAt }), 'utf8')
    return { id, kind: existing.kind, tags: existing.tags, createdAt: existing.createdAt, updatedAt, content: content.trim(), path }
}

export async function archiveMemoryFile(agentId: string, id: string): Promise<void> {
    const archiveDir = resolve(memoryDir(agentId), 'archive')
    await mkdir(archiveDir, { recursive: true })
    await rename(memoryPath(agentId, id), resolve(archiveDir, `${id}.md`))
}

export async function deleteMemoryFile(agentId: string, id: string): Promise<void> {
    await rm(memoryPath(agentId, id), { force: true })
}

export async function deleteAllMemoryFiles(agentId: string): Promise<void> {
    await rm(memoryDir(agentId), { recursive: true, force: true })
}

export async function readMemoryFile(path: string): Promise<MemoryFile> {
    return parseMemoryFile(path, matter(await readFile(path, 'utf8')))
}

function parseMemoryFile(path: string, parsed: matter.GrayMatterFile<string>): MemoryFile {
    const data = parsed.data as Record<string, unknown>
    return {
        id: typeof data.id === 'string' ? data.id : '',
        kind: typeof data.kind === 'string' ? data.kind : 'note',
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
        content: parsed.content.trim(),
        path,
    }
}

async function readDesktopMemoryFile(path: string): Promise<MemoryFile> {
    // Darwin's O_NOFOLLOW_ANY extends O_NOFOLLOW to ancestors if one is swapped after listing.
    const noFollow = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow)
    try {
        if (!(await file.stat()).isFile()) throw new Error('Invalid memory file.')
        const parsed = matter(await file.readFile('utf8'), { engines: { javascript: () => { throw new Error('Executable memory metadata is unsupported.') } } })
        return parseMemoryFile(path, parsed)
    } finally { await file.close() }
}

export async function listMemoryFiles(agentId: string, desktopRoot?: string): Promise<MemoryFile[]> {
    const root = desktopRoot ?? memoryDir(agentId)
    if (!existsSync(root)) return []
    const entries = await readdir(root, { withFileTypes: true })
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.md'))
    const read = desktopRoot ? readDesktopMemoryFile : readMemoryFile
    return Promise.all(files.map(e => read(resolve(root, e.name))))
}
