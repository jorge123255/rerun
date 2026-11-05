import {handleDesktopServices} from '@/lib/desktop/server/mcp-binding'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function POST(request:Request){return handleDesktopServices(request)}
