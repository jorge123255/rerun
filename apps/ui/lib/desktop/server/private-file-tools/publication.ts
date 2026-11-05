import 'server-only'
import {createHash} from 'node:crypto'
import type {Client} from '@libsql/client'
import {z} from 'zod'
import {readCoworkerFile,saveCoworkerFile,importCoworkerFile} from '../coworker-files'
import type {DesktopRuntime} from '../runtime'
import {abortable} from '../mcp/remote'
import {boundedPrivateText,editPrivateText,privateTextPath} from './semantics'
const id=z.string().min(1).max(200)
export const privateFileCall=z.object({engineAgentId:id,sessionId:id,runId:id,toolCallId:id,tool:z.enum(['fs_write','fs_edit']),arguments:z.union([z.object({path:z.string(),content:z.string()}).strict(),z.object({path:z.string(),oldString:z.string(),newString:z.string(),replaceAll:z.boolean().optional()}).strict()])}).strict()
export type PrivateFileCall=z.infer<typeof privateFileCall>
export type PrivateFileAuthority=(call:PrivateFileCall,signal:AbortSignal)=>Promise<{owner:string;runtime:DesktopRuntime}>
export const privateFileReceiptSchema=`CREATE TABLE IF NOT EXISTS desktop_private_file_calls (
 owner TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,digest TEXT NOT NULL,
 state TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,run_id,call_id));`
type Result={status:'saved'|'unchanged'|'unknown';path:string;message:string}
export function privateFilePublisher(db:Client,authorize:PrivateFileAuthority) {
    const pending=new Map<string,{digest:string;result:Promise<Result>}>()
    return async(call:PrivateFileCall,stop:AbortSignal):Promise<Result>=>{
        call=privateFileCall.parse(call)
        const signal=AbortSignal.any([stop,AbortSignal.timeout(30_000)])
        const authority=await abortable(authorize(call,signal),signal)
        const guard=async()=>{signal.throwIfAborted();const now=await abortable(authorize(call,signal),signal);signal.throwIfAborted();if(now.owner!==authority.owner || now.runtime.dataRoot!==authority.runtime.dataRoot)throw new Error('Private file owner changed')}
        await guard()
        const path=privateTextPath(call.arguments.path)
        if(call.tool==='fs_write' && !('content' in call.arguments) || call.tool==='fs_edit' && !('oldString' in call.arguments))throw new Error('Tool arguments do not match')
        if(Buffer.byteLength(JSON.stringify(call.arguments))>2*1024*1024)throw new Error('Private file arguments exceed limit')
        const digest=createHash('sha256').update(JSON.stringify([call.engineAgentId,call.sessionId,call.runId,call.tool,call.arguments])).digest('hex')
        const key=JSON.stringify([authority.owner,call.runId,call.toolCallId])
        const existing=pending.get(key)
        if(existing){if(existing.digest!==digest)throw new Error('Tool call identity was reused');const result=await abortable(existing.result,signal);await guard();return result}
        const work=async():Promise<Result>=>{
            const receipt=(await db.execute({sql:'SELECT * FROM desktop_private_file_calls WHERE owner=? AND run_id=? AND call_id=?',args:[authority.owner,call.runId,call.toolCallId]})).rows[0]
            if(receipt){if(receipt.digest!==digest)throw new Error('Tool call identity was reused');await guard();return receipt.state==='saved'?JSON.parse(String(receipt.result)):{status:'unknown',path,message:'Prior publication acknowledgement unavailable; inspect Files. This call will not be repeated.'}}
            let content:string,hash:string|undefined,identity:string|undefined,occurrences=0
            if('content' in call.arguments)content=boundedPrivateText(call.arguments.content)
            else {
                const opened=await readCoworkerFile(authority.runtime,authority.owner,path)
                await guard()
                if(opened.truncated || !opened.hash || !opened.identity)throw new Error('Complete editable document and file identity required')
                const edited=editPrivateText(opened.content,call.arguments.oldString,call.arguments.newString,call.arguments.replaceAll)
                content=edited.content;occurrences=edited.occurrences;hash=opened.hash;identity=opened.identity
                if(content===opened.content)return {status:'unchanged',path,message:'oldString and newString are identical; nothing to do.'}
            }
            await guard()
            const claim=await db.execute({sql:'INSERT INTO desktop_private_file_calls(owner,run_id,call_id,digest,state) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',args:[authority.owner,call.runId,call.toolCallId,digest,'claimed']})
            if(claim.rowsAffected!==1)throw new Error('Publication already claimed; retry the exact call to inspect its receipt')
            try {
                const publication={beforePublish:guard,existingDirectoryOnly:true as const}
                if(hash)await saveCoworkerFile(authority.runtime,authority.owner,path,content,hash,identity,publication)
                else {const slash=path.lastIndexOf('/');await importCoworkerFile(authority.runtime,authority.owner,slash<0?'':path.slice(0,slash),path.slice(slash+1),Buffer.from(content),publication)}
                const result:Result={status:'saved',path,message:hash?`Edited ${path} (${occurrences} replacement${occurrences===1?'':'s'})`:`Wrote ${Buffer.byteLength(content)} bytes to ${path}`}
                const recorded=await db.execute({sql:"UPDATE desktop_private_file_calls SET state='saved',result=? WHERE owner=? AND run_id=? AND call_id=? AND digest=?",args:[JSON.stringify(result),authority.owner,call.runId,call.toolCallId,digest]})
                if(recorded.rowsAffected!==1)throw new Error('Publication acknowledgement unavailable')
                await guard()
                return result
            } catch {return {status:'unknown',path,message:'Publication was refused or its acknowledgement is uncertain. Inspect Files; this call will not be repeated.'}}
        }
        const result=Promise.resolve().then(work)
        pending.set(key,{digest,result})
        try{return await result}finally{if(pending.get(key)?.result===result)pending.delete(key)}
    }
}
