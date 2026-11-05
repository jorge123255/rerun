import 'server-only'
import { request } from '@/lib/engine/client'
import { openDesktopDatabase } from '../database'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'
import { commitDesktopTemplateInstall } from './commit'

export function desktopTemplateAuthority(runtime: DesktopRuntime) {
    return {
        commitInstalled: async (input: Parameters<typeof commitDesktopTemplateInstall>[1]) => commitDesktopTemplateInstall(await openDesktopDatabase(runtime.dataRoot), input),
        initializeImportedSetup: async (input: { agentId: string; engineAgentId: string; importReceiptId: string; prompt: string; required: boolean; signal?: AbortSignal }) => {
            const { engineAgentId, signal, ...body } = input
            return request(engineOf(runtime), `/agents/${encodeURIComponent(engineAgentId)}/setup/import`,
                { method: 'POST', body: JSON.stringify(body), signal }, value => value as { revision: string })
        },
    }
}
