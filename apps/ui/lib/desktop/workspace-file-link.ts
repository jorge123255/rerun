/** Parse an engine Markdown link for owner verification on the server. */
export function desktopWorkspaceFileLink(href: string | undefined): { owner: string; path: string } | null {
    if (!href?.startsWith('/') || href.startsWith('//') || href.length > 4096) return null
    try {
        const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0])
        if (/[\\\u0000-\u001f\u007f]/.test(pathname) ||
            pathname.slice(1).split('/').some(part => !part || part === '.' || part === '..')) return null
        const match = pathname.match(/^\/(?:[^/]+\/)*?agents\/([^/]+)\/workspace\/(.+)$/)
        return match ? { owner: match[1], path: match[2] } : null
    } catch { return null }
}
