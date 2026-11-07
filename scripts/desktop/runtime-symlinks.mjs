import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

// Resolve the complete chain: a broken link is not a verified bundled asset.
export async function runtimeSymlinkIsContained(resourcesDir, path) {
    const root = await realpath(resourcesDir)
    let target
    try { target = await realpath(path) }
    catch { return false }
    const rel = relative(root, target)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
