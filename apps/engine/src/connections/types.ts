import type { z } from 'zod'
import type { ConnectionConfig, CustomProviderSnapshot, desktopOpencodeConnectionView } from '@rerun/contracts'

export { connectionConfigSchema, RERUN_CONNECTION_ID } from '@rerun/contracts'
export type { ConnectionConfig, ConnectionSummary } from '@rerun/contracts'

// The credentials live in `env`, never in `config` — nothing that reaches the API carries them.
export type LoadedConnection = {
    id: string
    config: ConnectionConfig
    env: Record<string, string>
    custom?: CustomProviderSnapshot
    opencode?: z.infer<typeof desktopOpencodeConnectionView>
}
