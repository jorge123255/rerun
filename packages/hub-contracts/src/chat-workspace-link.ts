// Where a file an agent names in its markdown lives: its own workspace, or the folder shared by the
// whole workspace. Each client turns it into the URL of its file proxy.
export type WorkspaceFileRef = { scope: 'agent' | 'shared'; path: string }

const AGENT_WORKSPACE_PATH = /^\/(?:.+\/)?agents\/[^/]+\/workspace\/(.+)$/
const SHARED_SPACE_PATH = /^\/(?:.+\/)?shared\/(.+)$/

function safePath(path: string): string | null {
    const segments = path.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) return null
    return segments.join('/')
}

// Read by hand rather than through `URL`, which React Native only half implements.
function enginePathFromHref(href: string | undefined, pattern: RegExp): string | null {
    if (!href?.startsWith('/') || href.startsWith('//')) return null

    let pathname: string
    try {
        pathname = decodeURIComponent(href.split(/[?#]/)[0])
    } catch {
        return null
    }

    const match = pathname.match(pattern)
    return match ? safePath(match[1]) : null
}

/**
 * Turns an engine-side absolute workspace path into the relative path understood by the Files API.
 * Browser URLs and arbitrary relative links are deliberately left alone, they stay plain links.
 */
export function agentWorkspacePathFromHref(href: string | undefined): string | null {
    return enginePathFromHref(href, AGENT_WORKSPACE_PATH)
}

/**
 * Which file an image the agent wrote in markdown shows. The agent names its own files the way it
 * sees them, relative to its workspace or as an absolute engine path, and a client would resolve
 * either against its own address and find nothing.
 */
export function agentImageRef(src: string | undefined): WorkspaceFileRef | null {
    if (!src || src.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(src)) return null
    if (src.startsWith('/')) {
        const workspacePath = enginePathFromHref(src, AGENT_WORKSPACE_PATH)
        if (workspacePath) return { scope: 'agent', path: workspacePath }
        const sharedPath = enginePathFromHref(src, SHARED_SPACE_PATH)
        return sharedPath ? { scope: 'shared', path: sharedPath } : null
    }

    let path: string
    try {
        path = decodeURIComponent(src.split(/[?#]/)[0])
    } catch {
        return null
    }
    const relativePath = safePath(path.replace(/^\.\//, ''))
    return relativePath ? { scope: 'agent', path: relativePath } : null
}
