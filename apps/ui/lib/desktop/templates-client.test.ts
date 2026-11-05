import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING } from '@rerun/contracts'
import { createDesktopTemplatesClient } from './templates-client'
const template = { templateId: 'a'.repeat(32), revision: 'b'.repeat(64) }
const requestId = '11111111-1111-4111-8111-111111111111'
const receiptId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'
afterEach(() => vi.unstubAllGlobals())

function fixture(reply: (body: Record<string, unknown>) => unknown, calls: Record<string, unknown>[]) {
    let id = requestId
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if(url.endsWith('/intent')) {
            if(body.againRequestId)id=crypto.randomUUID()
            return Response.json({...body.operation,requestId:id,...(body.operation.operation==='install'?{spaceId,positions:[{col:0,row:0}]}:{})})
        }
        calls.push(body)
        return Response.json(reply(body))
    })
    vi.stubGlobal('fetch',fetcher)
    return fetcher
}
it('reopens an unknown draft with its server-saved request identity',async()=>{
    const calls:Record<string,unknown>[]=[]
    fixture(body=>{if(calls.length===1)throw new Error('lost');return {...template,requestId:body.requestId,receiptId}},calls)
    const first=createDesktopTemplatesClient()
    await expect(first.createDraft(' Research team ')).rejects.toThrow('unknown')
    first.dispose()
    await expect(createDesktopTemplatesClient().createDraft('Research team')).resolves.toMatchObject(template)
    expect(calls).toEqual([{operation:'create-draft',title:'Research team',requestId},{operation:'create-draft',title:'Research team',requestId}])
})
it('adapts the canonical plan and preserves reviewed setup and selected paths',async()=>{
    const calls:Record<string,unknown>[]=[]
    fixture(body=>body.operation==='plan'?{...template,planRevision:'c'.repeat(64),proseWarning:DESKTOP_TEMPLATE_PROSE_WARNING,limits:DESKTOP_TEMPLATE_LIMITS,coworkers:[{
        agentId,name:'Ada',description:'Notes',sourceRevision:'d'.repeat(64),setup:{required:null,prompt:'',answered:false},
        included:[{path:'SOUL.md',bytes:5,kind:'instruction',sourceRevision:'e'.repeat(64),flagged:[],text:'Notes'}],
        selectableFiles:[{path:'workspace/keep.md',bytes:5,kind:'text',sourceRevision:'f'.repeat(64),flagged:[]}],selectableSkills:[],exclusions:[],redactions:[],strippedConfigKeys:[],blocked:null,
    }]}:{...template,status:'captured',requestId,receiptId},calls)
    const client=createDesktopTemplatesClient()
    const plan=await client.plan(template,{workspaceId:spaceId,agentIds:[agentId]})
    expect(plan.plans[0].included?.[0].text).toBe('Notes')
    await client.capture(template,plan,[{agentRowId:agentId,exclude:[],setup:{required:true,prompt:'Ask for a colour.'}}])
    expect(calls[1]).toMatchObject({operation:'capture',templateId:template.templateId,planRevision:'c'.repeat(64),selections:[{agentId,files:['workspace/keep.md'],skills:[],setup:{required:true,prompt:'Ask for a colour.'}}]})
})
it('never reports an uncertain install as installed and resumes it after client recreation',async()=>{
    const calls:Record<string,unknown>[]=[]
    fixture(body=>calls.length===1?{status:'uncertain',requestId:body.requestId,receiptId,recoverable:true,created:[],reason:'Retry this installation.'}:{status:'installed',...template,requestId:body.requestId,receiptId,coworkers:[]},calls)
    const first=createDesktopTemplatesClient()
    await expect(first.install(template)).rejects.toThrow('Retry this installation')
    first.dispose()
    const second=createDesktopTemplatesClient()
    await expect(second.install(template)).resolves.toEqual({receiptId,coworkers:[]})
    expect(calls[0]).toEqual(calls[1])
    await second.install(template,{again:true})
    expect(calls[2].requestId).not.toBe(calls[0].requestId)
})
it('rejects a successful body belonging to another template',async()=>{
    fixture(body=>({status:'installed',...template,templateId:'e'.repeat(32),requestId:body.requestId,receiptId,coworkers:[]}),[])
    await expect(createDesktopTemplatesClient().install(template)).rejects.toThrow('unknown')
})
