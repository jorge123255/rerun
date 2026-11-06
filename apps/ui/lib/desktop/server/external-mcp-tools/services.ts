import 'server-only'
import { serviceMutation } from '../services/api'
import type { LocalServices } from '../services/lifecycle'
import type { ServiceStore } from '../services/store'
import type { ExternalMcpServicesAuthority } from './operations'

export function createExternalMcpServicesAuthority(options: {
    services: LocalServices
    store: Pick<ServiceStore, 'list'>
}): ExternalMcpServicesAuthority {
    return {
        async listInstalled(owner, signal) {
            await options.services.current(owner, 'manage', undefined, signal)
            signal.throwIfAborted()
            const records = await options.store.list(owner)
            const result = []
            for (const record of records) {
                signal.throwIfAborted()
                if (record.owner !== owner) throw new Error('Service owner changed.')
                const view = await options.services.view(record, signal)
                result.push({ key: view.key, slug: view.slug, name: view.name, status: view.status, revision: view.revision, toolNames: [...view.toolNames] })
            }
            await options.services.current(owner, 'manage', undefined, signal)
            signal.throwIfAborted()
            return result
        },
        async mutate(owner, input, signal) {
            const parsed = serviceMutation.parse(input)
            signal.throwIfAborted()
            const result = await options.services.mutate(owner, parsed, signal)
            signal.throwIfAborted()
            if (result && typeof result === 'object' && 'status' in result && result.status === 'unknown') throw new Error('The connector mutation outcome is unknown.')
            return result
        },
    }
}
