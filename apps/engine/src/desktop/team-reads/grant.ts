import { lstat, readFile } from 'node:fs/promises'
import { desktopTeamReadGrantOn } from '@rerun/contracts'
import { configPath, isPathSegment } from '../../config/paths.js'

export type DesktopTeamGrantStat = { isFile: boolean; isSymbolicLink: boolean; nlink: number; size: number }

export type DesktopTeamGrantIo = {
    lstat(agentId: string): Promise<DesktopTeamGrantStat | null>
    readFile(agentId: string): Promise<string>
}

const MAX_CONFIG_BYTES = 1_000_000

/**
 * Fresh read of this coworker's config file. `agentConfigSchema` drops unknown grant ids, so the
 * dedicated flag is read from the raw JSON. Only boolean true counts. A symlink is not this file.
 */
export async function readDesktopTeamReadGrant(agentId: string, io: DesktopTeamGrantIo): Promise<boolean> {
    if (!isPathSegment(agentId)) return false
    let stat: DesktopTeamGrantStat | null
    try { stat = await io.lstat(agentId) } catch { return false }
    if (!stat || !stat.isFile || stat.isSymbolicLink || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES) return false
    try {
        return desktopTeamReadGrantOn(JSON.parse(await io.readFile(agentId)))
    } catch { return false }
}

function diskIo(): DesktopTeamGrantIo {
    return {
        async lstat(agentId) {
            try {
                const stat = await lstat(configPath(agentId))
                return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), nlink: stat.nlink, size: stat.size }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
        },
        readFile(agentId) { return readFile(configPath(agentId), 'utf8') },
    }
}

export function readDesktopTeamReadGrantFromDisk(agentId: string): Promise<boolean> {
    return readDesktopTeamReadGrant(agentId, diskIo())
}
