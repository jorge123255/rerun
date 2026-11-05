import { handleDesktopNativeWriteback } from '@/lib/desktop/server/mcp-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) { return handleDesktopNativeWriteback(request) }
