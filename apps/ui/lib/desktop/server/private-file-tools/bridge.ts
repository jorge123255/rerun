import 'server-only'
import {authenticateDesktopEngineRequest} from '../auth'
import {abortable,boundedText} from '../mcp/remote'
import {privateFileCall,type privateFilePublisher} from './publication'
export function privateFilePublicationApi(publish:ReturnType<typeof privateFilePublisher>) {
    return async(request:Request)=>{
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])
        try {
            await abortable(authenticateDesktopEngineRequest(request),signal)
            if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405})
            const body=privateFileCall.parse(JSON.parse(await boundedText(new Response(request.body),signal,2*1024*1024)))
            const result=await publish(body,signal)
            return Response.json(result,{headers:{'Cache-Control':'no-store'}})
        }catch{return Response.json({status:'refused',message:'Private file publication unavailable; no save acknowledgement.'},{status:400})}
    }
}
export const privateFileToolDefinitions=[
 {name:'fs_write',description:'Create a UTF-8 .txt or .md file in an existing private Files directory. Existing files are never replaced.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}},
 {name:'fs_edit',description:'Make a surgical edit to a private Files document by replacing an exact string. By default oldString must match exactly once.',inputSchema:{type:'object',properties:{path:{type:'string'},oldString:{type:'string',minLength:1},newString:{type:'string'},replaceAll:{type:'boolean',default:false}},required:['path','oldString','newString'],additionalProperties:false}},
] as const
