import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { modelEffortKey, modelEffortsSchema, type ModelEfforts } from '@rerun/contracts'
import { connectionsDir } from '../config/paths.js'
import { withKeyedLock } from '../lib/lock.js'

// The effort a person chose for a model. It follows the model, not the coworker: the same choice
// answers a coworker, the Chief of Staff and a routine that run it. Read once and held, like the
// workspace default beside it; every write goes through this module.
const path = () => resolve(connectionsDir(), 'model-efforts.json')
let cached: { file: string; efforts: ModelEfforts } | undefined

export async function readModelEfforts(): Promise<ModelEfforts> {
    const file = path()
    if (cached?.file === file) return cached.efforts
    let efforts: ModelEfforts = {}
    if (existsSync(file)) {
        // An unreadable file means no choice was made, never a failed run.
        try { efforts = modelEffortsSchema.parse(JSON.parse(await readFile(file, 'utf8'))) } catch { efforts = {} }
    }
    cached = { file, efforts }
    return efforts
}

/** The chosen effort for this model, when the model still offers it. */
export async function chosenModelEffort(connectionId: string, model: string, supported: readonly string[]): Promise<string | undefined> {
    const effort = (await readModelEfforts())[modelEffortKey(connectionId, model)]
    return effort && supported.includes(effort) ? effort : undefined
}

export function writeModelEffort(connectionId: string, model: string, effort: string | null): Promise<ModelEfforts> {
    return withKeyedLock('model-efforts', async () => {
        const next = { ...(await readModelEfforts()) }
        if (effort) next[modelEffortKey(connectionId, model)] = effort
        else delete next[modelEffortKey(connectionId, model)]
        await mkdir(connectionsDir(), { recursive: true })
        const file = path(), tmp = `${file}.tmp`
        await writeFile(tmp, `${JSON.stringify(next, null, 4)}\n`, 'utf8')
        await rename(tmp, file)
        cached = { file, efforts: next }
        return next
    })
}
