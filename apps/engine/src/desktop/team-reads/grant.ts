import { realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { desktopTeamReadGrantOn } from '@rerun/contracts'
import { configPath, dataDir, isPathSegment } from '../../config/paths.js'
import { readBoundedFileWithoutLinks } from '../open-without-links.js'

export type DesktopTeamGrantStat = { isFile: boolean; isSymbolicLink: boolean; nlink: number; size: number }

export type DesktopTeamGrantIo = {
    lstat(agentId: string): Promise<DesktopTeamGrantStat | null>
    readFile(agentId: string): Promise<string>
}

const MAX_CONFIG_BYTES = 1_000_000

function grantFromConfig(raw: string): boolean {
    const config: unknown = JSON.parse(raw)
    if (!desktopTeamReadGrantOn(config)) return false
    const { enabled = true, ephemeral = false } = config as { enabled?: unknown; ephemeral?: unknown }
    return enabled === true && ephemeral === false
}

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
        return grantFromConfig(await io.readFile(agentId))
    } catch { return false }
}

export async function readDesktopTeamReadGrantFromDisk(agentId: string): Promise<boolean> {
    if (!isPathSegment(agentId)) return false
    try {
        const root = dataDir()
        const path = join(await realpath(root), relative(root, configPath(agentId)))
        return grantFromConfig((await readBoundedFileWithoutLinks(path, MAX_CONFIG_BYTES)).toString('utf8'))
    } catch { return false }
}
