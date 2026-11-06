import { isAbsolute, relative, sep } from 'node:path'

export function pathEscapesRoot(root, candidate) {
    const rel = relative(root, candidate)
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}
