import { readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'

function inside(root, path) {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// The packager preserves link text when moving the tree. A link must stay
// inside the tree both as written and after its complete chain is resolved.
export async function runtimeSymlinkIsContained(resourcesDir, path) {
    const root = await realpath(resourcesDir)
    try {
        const target = await readlink(path)
        const parent = await realpath(dirname(path))
        if (isAbsolute(target) || !inside(root, parent)) return false
        let depth = relative(root, parent).split(sep).filter(Boolean).length
        for (const part of target.split(sep)) {
            if (part === '..') {
                if (depth === 0) return false
                depth--
            } else if (part && part !== '.') depth++
        }
        return inside(root, await realpath(path))
    } catch { return false }
}
