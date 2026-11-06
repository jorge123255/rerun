import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { engineOf } from '@/lib/desktop/server/settings'
import { request as engineRequest } from '@/lib/engine/client'
import { rollbackDesktopTemplateRequest } from '@/lib/desktop/server/templates/rollback'
export const dynamic = 'force-dynamic'
export function POST(request: Request) {
 return desktopRoute(request,async runtime=>{
  const engine=engineOf(runtime),db=await openDesktopDatabase(runtime.dataRoot)
  const value=await rollbackDesktopTemplateRequest(db,{post:(path,body,signal)=>engineRequest(engine,path,{method:'POST',body:JSON.stringify(body),signal},value=>value),get:(path,signal)=>engineRequest(engine,path,{method:'GET',signal},value=>value)},await request.json())
  return Response.json(value,{headers:{'cache-control':'no-store'}})
 })
}
