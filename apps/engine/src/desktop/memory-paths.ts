import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, pathSegment } from '../config/paths.js'
import { HttpError, notFound } from '../lib/errors.js'

// The app owns the data root. Coworker files below it must never redirect the list to a sibling
// or another location on the Mac, including through SQLite's optional stats database.
async function present(path: string, directory: boolean) {
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
    })
    if (!entry) return false
    if (!(directory ? entry.isDirectory() : entry.isFile())) throw new HttpError(403, 'Unsafe coworker memory location.')
    return true
}

export async function desktopMemoryPaths(id: string) {
    const agents = join(await realpath(dataDir()), 'agents')
    const agent = join(agents, pathSegment(id, 'agent id'))
    if (!await present(agents, true) || !await present(agent, true) || !await present(join(agent, 'config.json'), false)) throw notFound('agent')
    const memory = join(agent, 'memory')
    const hasMemory = await present(memory, true)
    const data = join(agent, 'data')
    const database = join(data, 'system.db')
    const hasData = await present(data, true)
    const hasIndex = hasData && await present(database, false)
    if (hasData) {
        for (const suffix of ['-wal', '-shm', '-journal']) await present(database + suffix, false)
    }
    return { memory, hasMemory, hasIndex }
}
