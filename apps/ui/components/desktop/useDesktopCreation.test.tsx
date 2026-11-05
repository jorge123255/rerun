// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {cancelDraftShutdown,flushDesktopDrafts} from '@/lib/desktop/draft-writes'
import {useDesktopCreation} from './useDesktopCreation'
import type {DesktopCreateOutcome,DesktopCreationIntent} from '@/lib/desktop/new-agent'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const intent:DesktopCreationIntent={requestId:'11111111-1111-4111-8111-111111111111',name:'Researcher',kickoff:'Read the report and give me three findings.',suggestionId:null,scheduled:false}
const position={col:3,row:5},spaceId='22222222-2222-4222-8222-222222222222'
const agent={id:'33333333-3333-4333-8333-333333333333',name:intent.name,description:'',createdAt:'now',updatedAt:'now',position,spaceId}
let root:Root|undefined
const captured:{api?:ReturnType<typeof useDesktopCreation>}={}
function Probe({created}:{created:Parameters<typeof useDesktopCreation>[0]}){captured.api=useDesktopCreation(created);return null}
async function mount(created:Parameters<typeof useDesktopCreation>[0]=vi.fn(async()=>{})){root=createRoot(document.body.appendChild(document.createElement('div')));await act(async()=>root!.render(<Probe created={created}/>));return created}
async function unmount(){if(root)await act(async()=>root!.unmount());root=undefined}
afterEach(async()=>{await unmount();captured.api=undefined;document.body.innerHTML='';vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();cancelDraftShutdown()})

it('creates nothing while choosing a tile and allows a definite local cancel before POST',async()=>{
 const fetcher=vi.fn(async()=>Response.json({pending:null}));vi.stubGlobal('fetch',fetcher);await mount()
 let outcome!:Promise<DesktopCreateOutcome>
 act(()=>{outcome=captured.api!.begin(intent,spaceId)})
 expect(captured.api!.placement).toMatchObject({intent,spaceId,submitted:false,saving:false})
 expect(fetcher).toHaveBeenCalledTimes(1)
 await act(async()=>{captured.api!.cancel();expect(await outcome).toEqual({kind:'refused',error:''})})
 expect(captured.api!.placement).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps an unknown response fixed across retry and a full hook remount',async()=>{
 let pending:unknown=null,posts=0
 const submitted:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(!init?.method)return Response.json({pending})
  if(init.method==='PATCH'){pending=null;return Response.json({acknowledged:true})}
  submitted.push(JSON.parse(String(init.body)));pending={intent,position,spaceId,phase:'started'}
  if(++posts===1)throw new Error('Reply lost after server commit')
  return Response.json({agent,sessionId:'first-chat'})
 }))
 await mount();act(()=>{void captured.api!.begin(intent,spaceId)})
 await act(async()=>captured.api!.place(position,spaceId))
 expect(captured.api!.placement).toMatchObject({intent,position,spaceId,submitted:true,saving:false})
 act(()=>captured.api!.cancel());expect(captured.api!.placement).not.toBeNull()
 expect(await captured.api!.begin({...intent,requestId:'different'})).toMatchObject({kind:'refused'})
 await unmount();const created=await mount()
 expect(captured.api!.placement).toMatchObject({intent,position,spaceId,submitted:true})
 await act(async()=>captured.api!.place({col:99,row:99},'different-box'))
 expect(submitted).toEqual([{intent,position,spaceId},{intent,position,spaceId}])
 expect(created).toHaveBeenCalledWith(agent,'first-chat',expect.anything());expect(captured.api!.placement).toBeNull()
})

it('acknowledges only after presentation and a lost acknowledgement never repeats POST',async()=>{
 const order:string[]=[];let acknowledgements=0
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{
  if(!init?.method)return Response.json({pending:null})
  order.push(init.method)
  if(init.method==='POST')return Response.json({agent,sessionId:'first-chat'})
  if(++acknowledgements===1)throw new Error('Acknowledgement lost')
  return Response.json({acknowledged:true})
 });vi.stubGlobal('fetch',fetcher)
 await mount(vi.fn(async()=>{order.push('merge-refresh-open')}));act(()=>{void captured.api!.begin(intent,spaceId)})
 await act(async()=>captured.api!.place(position,spaceId))
 expect(captured.api!.placement?.submitted).toBe(true);expect(captured.api!.placement?.error).toContain('coworker is created')
 await act(async()=>captured.api!.place(position,spaceId))
 expect(order).toEqual(['POST','merge-refresh-open','PATCH','PATCH']);expect(captured.api!.placement).toBeNull()
})

it('permits choosing a new spot only after an explicit definite refusal',async()=>{
 let first=true;const bodies:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(!init?.method)return Response.json({pending:null})
  if(init.method==='PATCH')return Response.json({acknowledged:true})
  bodies.push(JSON.parse(String(init.body)))
  if(first){first=false;return Response.json({error:'That spot is occupied.',code:'position_occupied',definite:true},{status:409})}
  return Response.json({agent,sessionId:'first-chat'})
 }))
 await mount();act(()=>{void captured.api!.begin(intent)})
 await act(async()=>captured.api!.place(position,spaceId))
 expect(captured.api!.placement).toMatchObject({submitted:false,position:undefined,spaceId:undefined})
 const next={col:10,row:12}
 await act(async()=>captured.api!.place(next,'other-box'))
 expect(bodies).toEqual([{intent,position,spaceId},{intent,position:next,spaceId:'other-box'}])
})

it('blocks new creation when the startup receipt is unavailable and permits a checked retry',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({pending:null}));vi.stubGlobal('fetch',fetcher)
 await mount();expect(captured.api!.checkError).toContain('previous creation')
 expect(await captured.api!.begin(intent)).toMatchObject({kind:'refused'})
 await act(async()=>captured.api!.refresh());expect(captured.api!.checkError).toBe('')
 act(()=>{void captured.api!.begin(intent)});expect(captured.api!.placement?.intent).toEqual(intent)
})

for(const boundary of ['fetch','body'] as const)it(`settles an uncooperative startup ${boundary} at its deadline and ignores its later pending receipt`,async()=>{
 vi.useFakeTimers()
 let finish!:(value:unknown)=>void
 const late=new Promise<unknown>(resolve=>{finish=resolve})
 const staleResponse=Response.json({pending:null})
 if(boundary==='body')vi.spyOn(staleResponse,'json').mockReturnValue(late)
 const fetcher=vi.fn().mockImplementationOnce(()=>boundary==='fetch'?late:Promise.resolve(staleResponse)).mockResolvedValue(Response.json({pending:null}))
 vi.stubGlobal('fetch',fetcher);await mount()
 expect(captured.api!.checking).toBe(true)
 await act(async()=>{await vi.advanceTimersByTimeAsync(15_000)})
 expect(captured.api!.checking).toBe(false);expect(captured.api!.checkError).toContain('previous creation')
 await act(async()=>captured.api!.refresh())
 act(()=>{void captured.api!.begin(intent,spaceId)})
 const old={pending:{intent:{...intent,requestId:'old-unknown'},position,spaceId}}
 await act(async()=>{finish(boundary==='fetch'?Response.json(old):old)})
 expect(captured.api!.placement).toMatchObject({intent,submitted:false});expect(captured.api!.placement?.position).toBeUndefined()
})

for(const boundary of ['post-fetch','post-body','ack-fetch','ack-body'] as const)it(`settles uncooperative ${boundary}, releases Quit admission and preserves the exact retry`,async()=>{
 vi.useFakeTimers()
 let finish!:(value:unknown)=>void
 const late=new Promise<unknown>(resolve=>{finish=resolve}),created=vi.fn(async()=>{})
 const postBodies:unknown[]=[];let acknowledgements=0,blocked=false
 const postReply={agent,sessionId:'first-chat'},ackReply={acknowledged:true}
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(!init?.method)return Response.json({pending:null})
  if(init.method==='POST')postBodies.push(JSON.parse(String(init.body)));else acknowledgements++
  const kind=init.method==='POST'?'post':'ack',body=kind==='post'?postReply:ackReply
  if(!blocked && boundary.startsWith(kind)){
   blocked=true
   if(boundary.endsWith('fetch'))return late
   const response=Response.json(body);vi.spyOn(response,'json').mockReturnValue(late);return response
  }
  return Response.json(body)
 }))
 await mount(created);act(()=>{void captured.api!.begin(intent,spaceId)})
 let placing!:Promise<void>
 await act(async()=>{placing=captured.api!.place(position,spaceId)})
 await act(async()=>{await vi.advanceTimersByTimeAsync(45_000);await placing})
 expect(captured.api!.placement).toMatchObject({intent,position,spaceId,submitted:true,saving:false})
 expect(await flushDesktopDrafts()).toBe(true);cancelDraftShutdown()
 const beforeAck=acknowledgements
 const body=boundary.startsWith('post')?postReply:ackReply
 await act(async()=>finish(boundary.endsWith('fetch')?Response.json(body):body))
 expect(acknowledgements).toBe(beforeAck);expect(captured.api!.placement?.submitted).toBe(true)
 await act(async()=>captured.api!.place({col:99,row:99},'wrong-space'))
 expect(postBodies).toEqual(boundary.startsWith('post')?[{intent,position,spaceId},{intent,position,spaceId}]:[{intent,position,spaceId}])
 expect(captured.api!.placement).toBeNull()
})

it('times out a presentation callback, passes cancellation and never acknowledges its late completion',async()=>{
 vi.useFakeTimers()
 let finish!:()=>void,presentations=0,acknowledgements=0,oldSignal!:AbortSignal
 const created:Parameters<typeof useDesktopCreation>[0]=async(_agent,_session,signal)=>{
  if(++presentations===1){oldSignal=signal;await new Promise<void>(resolve=>{finish=resolve});signal.throwIfAborted()}
 }
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
  if(!init?.method)return Response.json({pending:null})
  if(init.method==='POST')return Response.json({agent,sessionId:'first-chat'})
  acknowledgements++;return Response.json({acknowledged:true})
 }))
 await mount(created);act(()=>{void captured.api!.begin(intent,spaceId)})
 let placing!:Promise<void>
 await act(async()=>{placing=captured.api!.place(position,spaceId)})
 await act(async()=>{await vi.advanceTimersByTimeAsync(45_000);await placing})
 expect(oldSignal.aborted).toBe(true);expect(captured.api!.placement?.saving).toBe(false)
 await act(async()=>finish());expect(acknowledgements).toBe(0)
 expect(await flushDesktopDrafts()).toBe(true);cancelDraftShutdown()
 await act(async()=>captured.api!.place(position,spaceId))
 expect(presentations).toBe(2);expect(acknowledgements).toBe(1);expect(captured.api!.placement).toBeNull()
})
