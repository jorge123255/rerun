import 'server-only'
import type { DesktopRuntime } from '../../runtime'
import { getDesktopRemoteMcpService } from '../../mcp-binding'

/** Route bundles share the canonical process-wide MCP/service authority. */
export async function desktopServiceAccounts(runtime: DesktopRuntime) {
    return (await getDesktopRemoteMcpService(runtime)).accounts
}
