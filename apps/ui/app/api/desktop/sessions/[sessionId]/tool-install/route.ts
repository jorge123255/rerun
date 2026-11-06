import { handleDesktopToolInstall } from '@/lib/desktop/server/tool-install/runtime'
export const runtime = 'nodejs'
type Context = { params: Promise<{ sessionId: string }> }
export async function GET(request: Request, context: Context) { return handleDesktopToolInstall(request, (await context.params).sessionId) }
export async function POST(request: Request, context: Context) { return handleDesktopToolInstall(request, (await context.params).sessionId) }
