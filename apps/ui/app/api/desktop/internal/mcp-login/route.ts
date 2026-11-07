import { handleDesktopMcpLoginBridge } from '@/lib/desktop/server/mcp-login-binding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const POST = handleDesktopMcpLoginBridge
