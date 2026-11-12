import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readSharedBytes } from '@/lib/desktop/server/shared-file-previews/read-shared-bytes'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const paths = query.getAll('path'), versions = query.getAll('version'), workspaces = query.getAll('workspaceId'), identities = query.getAll('identity')
        const digest = /^[a-f0-9]{64}$/
        if (paths.length !== 1 || versions.length !== 1 || !digest.test(versions[0]) || workspaces.length !== 1
            || identities.length > 1 || (identities.length === 1 && !digest.test(identities[0]))) {
            throw new DesktopHttpError(400, 'Choose one listed shared file to save.')
        }
        if (workspaces[0] !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
        const file = await readSharedBytes(runtime, paths[0], 'download', {
            version: versions[0], signal: request.signal, beforeCommit: () => assertDesktopWorkspaceAdmission(runtime),
        })
        if (identities.length && file.identity !== identities[0]) throw new DesktopHttpError(409, 'This shared file changed. Reopen it before saving.')
        const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        return new Response(new Uint8Array(file.bytes), { headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(file.bytes.byteLength),
            'content-disposition': `attachment; filename*=UTF-8''${name}`,
            'x-rerun-shared-version': versions[0],
            'x-rerun-shared-sha256': file.identity,
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        } })
    })
}
