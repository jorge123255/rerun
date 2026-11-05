import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING, desktopTemplateOperationSchema } from '@rerun/contracts'
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


it('opens a captured draft or library row using only its exact template identity', async () => {
    const calls: Record<string, unknown>[] = []
    fixture(body => {
        expect(desktopTemplateOperationSchema.safeParse(body).success).toBe(true)
        return { ...template, title: 'QA template', capturedAt: '2026-11-05T00:00:00Z', engineCommit: null,
            proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING, limits: DESKTOP_TEMPLATE_LIMITS,
            coworkers: [{ agentKey: 'c01', name: 'QA coworker', description: '', setup: { required: true, prompt: 'QA guide', answered: true },
                files: [], exclusions: [], redactions: [], strippedConfigKeys: [], envKeys: [], mcpAuth: [] }] }
    }, calls)
    const client = createDesktopTemplatesClient()
    const draft = { ...template, title: 'QA template', receiptId, requestId }
    const row = await client.detail(draft)
    expect(row.title).toBe('QA template')
    expect((await client.detail(row)).agents[0].name).toBe('QA coworker')
    expect(calls).toEqual([0, 1].map(() => ({ operation: 'detail', ...template })))
})

it('reads current installation with GET only and validates the exact template identity', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ status: 'installed', ...template, requestId, receiptId, coworkers: [] }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopTemplatesClient()
    await expect(client.currentInstall({ ...template })).resolves.toMatchObject({ status: 'installed', requestId, receiptId })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/desktop/templates/intent?templateId=${template.templateId}&revision=${template.revision}`, expect.objectContaining({ method: 'GET', cache: 'no-store' }))
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
    fetcher.mockImplementationOnce(async () => Response.json({ status: 'none', ...template, revision: 'c'.repeat(64) }))
    await expect(client.currentInstall(template)).rejects.toThrow('unknown')
})

it('recovers a pending attempt without mutation and refuses a different retry identity before execution', async () => {
    const calls: { method: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const method = String(init.method)
        calls.push({ method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
        return Response.json(method === 'GET' ? { status: 'pending', ...template, requestId } : { operation: 'install', ...template, requestId: '55555555-5555-4555-8555-555555555555', spaceId, positions: [{ col: 0, row: 0 }] })
    }))
    const client = createDesktopTemplatesClient()
    await client.currentInstall(template)
    expect(client.pendingInstall(template)).toEqual({ ...template, requestId })
    expect(calls).toEqual([{ method: 'GET' }])
    await expect(client.install(template, { requestId })).rejects.toThrow('installation changed')
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({ operation: { operation: 'install', ...template } })
})

it('a read-confirmed lost Use again response clears only the completed rotation before a new explicit copy', async () => {
    let currentRequest = requestId
    let loseResponse = true
    const rotations: string[] = []
    const posts: string[] = []
    const identities = new Map<string, string>()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'GET') return Response.json({ status: 'installed', ...template, requestId: currentRequest, receiptId, coworkers: [] })
        const body = JSON.parse(String(init.body))
        if (url.endsWith('/intent')) {
            rotations.push(body.againRequestId)
            if (!identities.has(body.againRequestId)) identities.set(body.againRequestId, crypto.randomUUID())
            currentRequest = identities.get(body.againRequestId)!
            return Response.json({ ...body.operation, requestId: currentRequest, spaceId, positions: [{ col: 0, row: 0 }] })
        }
        posts.push(body.requestId)
        if (loseResponse) { loseResponse = false; throw new Error('response lost') }
        return Response.json({ status: 'installed', ...template, requestId: body.requestId, receiptId, coworkers: [] })
    }))
    const client = createDesktopTemplatesClient()
    await client.currentInstall(template)
    await expect(client.install(template, { again: true })).rejects.toThrow('unknown')
    expect(client.pendingInstall(template)?.requestId).toBe(currentRequest)
    await client.currentInstall(template)
    expect(client.pendingInstall(template)).toBeNull()
    expect(posts).toHaveLength(1)
    await client.install(template, { again: true })
    expect(rotations).toHaveLength(2)
    expect(rotations[0]).not.toBe(rotations[1])
    expect(posts[0]).not.toBe(posts[1])
})

it('a late pre-install status read cannot replace the completed attempt', async () => {
    let finishRead!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'GET') return new Promise<Response>(resolve => { finishRead = resolve })
        const body = JSON.parse(String(init.body))
        if (url.endsWith('/intent')) return Response.json({ ...body.operation, requestId, spaceId, positions: [{ col: 0, row: 0 }] })
        return Response.json({ status: 'installed', ...template, requestId, receiptId, coworkers: [] })
    }))
    const client = createDesktopTemplatesClient()
    const read = client.currentInstall(template)
    const rejected = expect(read).rejects.toThrow('unknown')
    await client.install(template)
    finishRead(Response.json({ status: 'pending', ...template, requestId }))
    await rejected
    expect(client.pendingInstall(template)).toBeNull()
})
