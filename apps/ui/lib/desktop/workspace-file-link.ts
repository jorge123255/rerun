import { agentImageRef } from '@rerun/contracts'

function decodedPath(href: string | undefined): string | null {
    if (!href || href.length > 4096) return null
    try {
        const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0])
        return /[\\\u0000-\u001f\u007f]/.test(pathname) ? null : pathname
    } catch { return null }
}

function isAbsoluteWorkspacePath(path: string): boolean {
    return path.startsWith('/') && !path.slice(1).split('/').some(part => !part || part === '.' || part === '..')
}

/** Parse an engine Markdown link for owner verification on the server. */
export function desktopWorkspaceFileLink(href: string | undefined): { owner: string; path: string } | null {
    if (!href?.startsWith('/')) return null
    const pathname = decodedPath(href)
    if (!pathname || !isAbsoluteWorkspacePath(pathname)) return null
    const match = pathname.match(/^\/(?:[^/]+\/)*?agents\/([^/]+)\/workspace\/(.+)$/)
    return match ? { owner: match[1], path: match[2] } : null
}

/** Resolve upstream workspace image references into same-origin desktop preview routes. */
export function desktopWorkspaceImageUrl(agentId: string, href: string | undefined): string | null {
    const pathname = decodedPath(href)
    if (!pathname || (pathname.startsWith('/') && !isAbsoluteWorkspacePath(pathname))) return null
    const workspace = desktopWorkspaceFileLink(href)
    const ref = workspace ?? agentImageRef(href)
    if (!ref) return null
    const query = new URLSearchParams({ path: ref.path })
    if ('scope' in ref && ref.scope === 'shared') return '/api/desktop/shared-files/media?' + query
    if (workspace) query.set('workspaceOwner', workspace.owner)
    query.set('animation', '1')
    return `/api/desktop/agents/${encodeURIComponent(agentId)}/files/image?` + query
}
