import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../config/paths.js'

/**
 * Why the last plan usage read of a provider gave what it gave: an outcome word, an HTTP status,
 * field names. Never a token or an account detail. The engine's log lines are not kept in the Mac
 * app, so this one small file is how a missing gauge can be explained afterwards.
 */
export function noteDesktopPlanUsage(provider: string, note: { outcome: string; status?: number; fields?: string[] }): void {
    // Only the engine the Mac app started writes it; a test or a server engine has its own logs.
    if (!process.env.RERUN_DESKTOP_RUNTIME_FILE) return
    try {
        const directory = join(dataDir(), 'diagnostics')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const file = join(directory, 'plan-usage.json')
        let notes: Record<string, unknown> = {}
        try { notes = JSON.parse(readFileSync(file, 'utf8')) } catch { /* first note */ }
        notes[provider] = { ...note, fields: note.fields?.slice(0, 24).map(field => field.slice(0, 48)), at: new Date().toISOString() }
        const temp = `${file}.${randomUUID()}.tmp`
        writeFileSync(temp, JSON.stringify(notes, null, 2), { mode: 0o600 })
        renameSync(temp, file)
    } catch {
        // A diagnostic that cannot be written is not worth an error.
    }
}
