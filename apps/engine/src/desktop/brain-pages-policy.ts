import { brainSlugSchema } from '@rerun/contracts'

export function desktopBrainPagesRouteAllowed(method: string, path: string): boolean {
    const prefix = '/desktop/brain/pages'
    if (path === prefix) return method === 'GET'
    if (!path.startsWith(`${prefix}/`)) return false
    const parts = path.slice(prefix.length + 1).split('/')
    if (!brainSlugSchema.safeParse(parts[0]).success) return false
    if (parts.length === 1) return ['GET', 'PUT', 'DELETE'].includes(method)
    if (parts.length === 2) return (parts[1] === 'revisions' && method === 'GET') || (parts[1] === 'confirm' && method === 'POST')
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/.test(parts[2])) return false
    return (parts[1] === 'revisions' && method === 'GET') || (parts[1] === 'revert' && method === 'POST')
}
