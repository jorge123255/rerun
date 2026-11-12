/** Resolve an engine Markdown link within the coworker that owns the reply. */
export function desktopWorkspaceFilePath(href: string | undefined, engineAgentId: string): string | null {
    if (!href?.startsWith('/') || href.startsWith('//') || href.length > 4096) return null
    try {
        const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0])
        if (/[\\\u0000-\u001f\u007f]/.test(pathname) ||
            pathname.slice(1).split('/').some(part => !part || part === '.' || part === '..')) return null
        const match = pathname.match(/^\/(?:[^/]+\/)*?agents\/([^/]+)\/workspace\/(.+)$/)
        return match?.[1] === engineAgentId ? match[2] : null
    } catch { return null }
}
