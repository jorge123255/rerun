import {handleDesktopServices} from '@/lib/desktop/server/mcp-binding'
export const runtime='nodejs'
export const dynamic='force-dynamic'
async function handle(request:Request,context:{params:Promise<{agentId:string}>}){
 return handleDesktopServices(request,(await context.params).agentId)
}
export {handle as GET,handle as POST}
