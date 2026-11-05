import 'server-only'

import type { DesktopServiceMethodAvailability } from '@rerun/contracts'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'
import type { ServiceManifest } from '@/lib/services/manifest'
import { compileAccountService } from './compiler'

/**
 * Exact method id only. Does not call hosted `getMethod`, so an unknown id
 * cannot fall through to the recommended method.
 */
export function accountMethodAvailability(manifest: ServiceManifest, methodId: string): DesktopServiceMethodAvailability {
    const method = manifest.authMethods.find(item => item.id === methodId)
    if (!method) return { id: methodId, supported: false, reason: M.unknownMethod }
    const values = Object.fromEntries(method.inputs.map(input => [input.key, input.secret ? 'local-shape-check' : 'local-shape']))
    try {
        compileAccountService(manifest, methodId, values, { id: methodId, supported: true }, { label: manifest.name })
        return { id: methodId, supported: true }
    } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : M.unsupported
        return { id: methodId, supported: false, reason }
    }
}

/** Original Add account visibility: installed and active, plus a supported method. */
export function additionalAccountVisible(input: { multiInstance: boolean; installStatus: string | null | undefined; availability: DesktopServiceMethodAvailability[] }): boolean {
    return input.multiInstance === true && input.installStatus === 'active' && input.availability.some(method => method.supported)
}
