import { join } from 'node:path'
import { pathExists } from './workspaces/paths.mjs'

export async function hasLocalWorkspace(dataRoot) {
    // An older workspace can still have data even if its identity is missing.
    // Give it the normal local startup and recovery path in that case.
    for (const entry of ['identity.encrypted', 'app.db', 'workspaces']) {
        if (await pathExists(join(dataRoot, entry))) return true
    }
    return false
}
