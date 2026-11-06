import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { migrate } from '../db/migrate.js'
import { latestVersion } from '../db/ladder.js'
import { foldAgentKeysIntoConnections } from '../connections/migrate.js'
import { initializeDesktopBrainStore } from '../desktop/brain-pages-router.js'
import { initializeDesktopPortableFiles } from '../desktop/templates/portable-files.js'
import { initializeDesktopSemanticIndex } from '../desktop/semantic-memory/index-store.js'
import { desktopApp } from '../desktop/policy.js'
import { join } from 'node:path'
import { boxPlanPath, mcpPackagesDir, dataDir } from '../config/paths.js'

// One change to the layout of the data-dir: a file or folder moved, renamed, rewritten, or a schema
// change of `rerun.db`. A shipped step is never edited nor removed, because an archived data-dir may
// come back from before it. `up` must be re-runnable: a crash between the step and the version write
// replays it on the next boot. Per-agent `system.db` and `shared.db` carry their own ladders.
export type DataDirMigration = { version: number; id: string; up: () => Promise<void> }

export const DATA_DIR_MIGRATIONS: DataDirMigration[] = [
    {
        // Everything that existed before the ladder, each piece already idempotent, so a folder that
        // has none of it and one that has all of it both land here safely.
        version: 1,
        id: 'baseline',
        up: async () => {
            await migrate()
            await foldAgentKeysIntoConnections()
        },
    },
    {
        // The plan the hub pushes, written out explicitly for a box that has not heard from it yet.
        // Unrestricted, which is what an engine reads when the file is missing, so a box restored
        // from before this step keeps running whatever its agents asked for until the hub says so.
        version: 2,
        id: 'box-plan',
        up: async () => {
            const target = boxPlanPath()
            if (existsSync(target)) return
            const tmp = `${target}.tmp`
            await writeFile(tmp, `${JSON.stringify({ premiumModels: true }, null, 4)}\n`, 'utf8')
            await rename(tmp, target)
        },
    },
    {
        // Where the MCP packages an agent launches with `npx` are installed once. An engine from
        // before this step never reads it, and one after it fills it on its own.
        version: 3,
        id: 'mcp-packages',
        up: async () => {
            await mkdir(mcpPackagesDir(), { recursive: true })
        },
    },
    {
        version: 4,
        id: 'desktop-brain-and-native-review',
        up: async () => {
            if (!desktopApp()) return
            await initializeDesktopBrainStore()
            await mkdir(join(dataDir(), 'desktop-native-writeback-outbox'), { recursive: true, mode: 0o700 })
        },
    },
    {
        version: 5,
        id: 'desktop-portable-templates-and-semantic-memory',
        up: async () => {
            if (!desktopApp()) return
            await initializeDesktopPortableFiles(dataDir())
            const directory = join(dataDir(), 'desktop-semantic-memory')
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await initializeDesktopSemanticIndex(directory)
        },
    },
]

export const DATA_DIR_VERSION = latestVersion(DATA_DIR_MIGRATIONS)
