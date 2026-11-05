import {localServicesBinding} from '@/lib/desktop/server/services/binding'
export const runtime='nodejs'
export const dynamic='force-dynamic'
async function handle(request:Request,context:{params:Promise<{agentId:string}>}){
 try{return await localServicesBinding().api(request,(await context.params).agentId)}catch{return Response.json({error:'Local services unavailable until initialization.'},{status:503})}
}
export {handle as GET,handle as POST}
