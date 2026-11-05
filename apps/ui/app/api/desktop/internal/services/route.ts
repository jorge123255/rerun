import {localServicesBinding} from '@/lib/desktop/server/services/binding'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function POST(request:Request){try{return await localServicesBinding().bridge.api(request)}catch{return Response.json({error:'Local services unavailable until initialization.'},{status:503})}}
