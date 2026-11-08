import 'server-only'
import type { CustomProviderAuthority } from '@rerun/contracts'
import { createCustomProviderRuntime } from '../../../../../engine/src/desktop/custom-providers/runtime'
import { handleCustomProviderRequest } from '../../../../../engine/src/desktop/custom-providers/router'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'

export function createDesktopCustomProviderApi(authority: CustomProviderAuthority) {
    const providers = createCustomProviderRuntime(authority)
    return {
        request(runtime: DesktopRuntime, request: Request): Promise<Response> {
            return handleCustomProviderRequest(authority, providers, runtime.workspaceId, async signal => {
                signal.throwIfAborted()
                const current = await readDesktopRuntime()
                signal.throwIfAborted()
                if (current.workspaceId !== runtime.workspaceId || current.launchNonce !== runtime.launchNonce) throw new Error('Workspace changed.')
            }, request)
        },
        close: () => providers.close(),
    }
}
