import 'server-only'
import { createDesktopMcpLoginRoute } from '../../../../engine/src/desktop/mcp-login-tools/route'
import { authenticateDesktopEngineRequest } from './auth'
import { getDesktopRemoteMcpService, watchDesktopMcpOwner } from './mcp-binding'

/** HTTP inventory and FX02 admission only. Device-code custody is not supplied. */
export const handleDesktopMcpLoginBridge = createDesktopMcpLoginRoute({
    authenticate: authenticateDesktopEngineRequest,
    service: getDesktopRemoteMcpService,
    watchOwner: watchDesktopMcpOwner,
})
