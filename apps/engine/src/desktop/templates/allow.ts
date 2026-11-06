// Kept separate from policy.ts so root can call this without an import cycle.
export function desktopTemplateRouteAllowed(method: string, path: string): boolean {
    if (path === '/desktop/templates' && method === 'GET') return true
    if (/^\/desktop\/templates\/[a-f0-9]{32}$/.test(path) && method === 'GET') return true
    if (/^\/desktop\/templates\/(?:draft|plan|capture|install)$/.test(path) && method === 'POST') return true
    if (/^\/desktop\/templates\/(?:export|import-package|delete)$/.test(path)) return method === 'POST'
    if (/^\/desktop\/templates\/portable-receipt\/[a-f0-9-]{36}$/.test(path)) return method === 'GET'
    if (/^\/desktop\/templates\/uploads\/[a-f0-9-]{36}$/.test(path)) return method === 'POST' || method === 'GET'
    if (/^\/desktop\/templates\/artifacts\/[a-f0-9]{32}(?:\/content)?$/.test(path)) return method === 'GET'
    return false
}
