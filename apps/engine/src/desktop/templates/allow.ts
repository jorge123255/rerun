// Kept separate from policy.ts so root can call this without an import cycle.
export function desktopTemplateRouteAllowed(method: string, path: string): boolean {
    if (path === '/desktop/templates' && method === 'GET') return true
    if (/^\/desktop\/templates\/[a-f0-9]{32}$/.test(path) && method === 'GET') return true
    if (/^\/desktop\/templates\/(?:draft|plan|capture|install)$/.test(path) && method === 'POST') return true
    return false
}
