import { createDesktopExternalMcpToolsHandler } from '@/lib/desktop/server/external-mcp-tools/bridge'
import { createExternalMcpServicesAuthority } from '@/lib/desktop/server/external-mcp-tools/services'
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const POST = createDesktopExternalMcpToolsHandler({ services: async runtime => {
    const binding = await getDesktopRemoteMcpService(runtime)
    return createExternalMcpServicesAuthority({ services: binding.services, store: binding.installedServices })
} })
