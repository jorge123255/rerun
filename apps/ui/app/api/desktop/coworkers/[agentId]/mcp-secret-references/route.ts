import { handleDesktopMcpSecretReferences } from '@/lib/desktop/server/mcp-secret-references/http'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
async function handle(request: Request, { params }: Context) { return handleDesktopMcpSecretReferences(request, (await params).agentId) }
export { handle as GET, handle as POST }
