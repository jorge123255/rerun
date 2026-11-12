// A board image the context menu may save. The page paints coworker and shared rasters from
// these same-origin routes (DesktopWorkspaceMessage, file thumbnails). Blob previews, PDF page
// rasters, document attachments, and formats the preview re-encodes (SVG, AVIF, ICO, BMP) are
// not represented here: they have no version-checked export of the bytes on screen.

const AGENT_ID = /^[A-Za-z0-9_-]{1,200}$/
const ENGINE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const FILE_IDENTITY = /^\d{1,24}:\d{1,24}$/
const DIGEST = /^[a-f0-9]{64}$/
const RASTER = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }

function validName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 255
        && !name.startsWith('.') && !/[\\/\p{Cc}]/u.test(name)
}

function imagePath(path, maxParts) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.startsWith('/') || path.includes('\\')) return null
    const parts = path.split('/')
    if (parts.length > maxParts || parts.some(part => !validName(part))) return null
    const name = parts.at(-1)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const raster = Object.hasOwn(RASTER, extension) ? RASTER[extension] : null
    return raster ? { path, name, raster } : null
}

function query(url, allowed) {
    const values = {}
    for (const key of url.searchParams.keys()) {
        if (!allowed.includes(key)) return null
        const all = url.searchParams.getAll(key)
        if (all.length !== 1 || all[0].length === 0 || all[0].length > 4096) return null
        values[key] = all[0]
    }
    return values
}

function boardPage(pageURL, srcURL) {
    if (typeof pageURL !== 'string' || typeof srcURL !== 'string') return null
    let page, src
    try {
        page = new URL(pageURL)
        src = new URL(srcURL)
    } catch { return null }
    if (page.origin !== src.origin || (page.protocol !== 'http:' && page.protocol !== 'https:')) return null
    if (page.username || page.password || src.username || src.password || src.hash) return null
    return src
}

/** The workspace image behind a displayed <img>, or null when this menu must not save it. */
export function displayedImageTarget(pageURL, srcURL) {
    const src = boardPage(pageURL, srcURL)
    if (!src) return null
    if (src.pathname === '/api/desktop/shared-files/media') return sharedTarget(src)
    const match = src.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/files\/image$/)
    if (!match || !AGENT_ID.test(match[1])) return null
    const params = query(src, ['path', 'animation', 'workspaceOwner', 'identity', 'revision'])
    if (!params || (params.animation !== undefined && params.animation !== '1')) return null
    if (params.workspaceOwner !== undefined && !ENGINE_OWNER.test(params.workspaceOwner)) return null
    if (params.identity !== undefined && !FILE_IDENTITY.test(params.identity)) return null
    if (params.revision !== undefined && (params.revision.length > 64 || /[\p{Cc}]/u.test(params.revision))) return null
    const file = imagePath(params.path, 64)
    if (!file) return null
    return { kind: 'coworker', agentId: match[1], ...file, ...(params.identity !== undefined && { identity: params.identity }),
        ...(params.revision !== undefined && { revision: params.revision }) }
}

function sharedTarget(src) {
    const params = query(src, ['path', 'animation', 'identity'])
    if (!params || (params.animation !== undefined && params.animation !== '1')) return null
    if (params.identity !== undefined && !DIGEST.test(params.identity)) return null
    const file = imagePath(params.path, 32)
    if (!file) return null
    return { kind: 'shared', ...file, ...(params.identity !== undefined && { identity: params.identity }) }
}

export function sameDisplayedImage(left, right) {
    return !!left && !!right && left.kind === right.kind && left.agentId === right.agentId
        && left.path === right.path && left.name === right.name && left.raster === right.raster && left.identity === right.identity
        && left.revision === right.revision
}

/** Kind implied by the file bytes, not by the filename. */
export function verifiedImageKind(bytes) {
    if (!(bytes instanceof Uint8Array)) return null
    const size = bytes.byteLength
    if (size >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
    if (size >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
    if (size >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'gif'
    if (size >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
    return null
}
