import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { boxDefaultModelSchema, type BoxDefaultModel } from '@rerun/contracts'
import { boxDefaultPath, connectionsDir } from '../config/paths.js'
import { clearAgentCache } from '../agents/registry.js'
import { withKeyedLock } from '../lib/lock.js'

// Read once and held: the engine is a single process, and every write to the file goes through
// this module, so there is no other writer to miss.
let cached: BoxDefaultModel | null | undefined

export async function readBoxDefault(): Promise<BoxDefaultModel | null> {
    if (cached !== undefined) return cached
    const path = boxDefaultPath()
    if (!existsSync(path)) return (cached = null)
    try {
        cached = boxDefaultModelSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch {
        // A file we cannot read is not a reason to take every default agent down: the resolution
        // ladder falls through to Rerun exactly as it does on a box that never set one.
        cached = null
    }
    return cached
}

// Dropping every cached agent is what `unloadConnection` does for the same reason: each one holds a
// pair resolved against the old default. A run already in flight keeps its own, captured in locals
// before the first step, so nothing switches models mid-turn.
async function commit(next: BoxDefaultModel | null): Promise<void> {
    cached = next
    clearAgentCache()
}

async function persistBoxDefault(next: BoxDefaultModel): Promise<BoxDefaultModel> {
    await mkdir(connectionsDir(), { recursive: true })
    const target = boxDefaultPath()
    const tmp = `${target}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 4)}\n`, 'utf8')
    await rename(tmp, target)
    await commit(next)
    return next
}

export function writeBoxDefault(next: BoxDefaultModel): Promise<BoxDefaultModel> {
    return withKeyedLock('box-default', () => persistBoxDefault(next))
}

export function updateBoxDefault(update: (current: BoxDefaultModel | null) => BoxDefaultModel): Promise<BoxDefaultModel> {
    return withKeyedLock('box-default', async () => persistBoxDefault(update(await readBoxDefault())))
}

// A catalog refresh can retire a model while the user is choosing another one in Settings.
export function replaceBoxDefaultIfCurrent(previous: BoxDefaultModel | null, next: BoxDefaultModel): Promise<void> {
    return withKeyedLock('box-default', async () => {
        const current = await readBoxDefault()
        if (current?.connectionId === previous?.connectionId && current?.model === previous?.model && current?.reasoningEffort === previous?.reasoningEffort) {
            await persistBoxDefault(next)
        }
    })
}

export async function clearBoxDefault(): Promise<void> {
    await withKeyedLock('box-default', async () => {
        await rm(boxDefaultPath(), { force: true })
        await commit(null)
    })
}
