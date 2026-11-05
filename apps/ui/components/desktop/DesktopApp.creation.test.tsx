// @vitest-environment happy-dom
import {act,type ComponentProps} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {MotionConfig} from 'motion/react'
import {DesktopApp} from './DesktopApp'
import {createDesktopDraftFixture} from '@/test/desktop-draft-fixture'
import {createDesktopRecentFixture} from '@/test/desktop-recent-fixture'
import type {DesktopBoardState} from '@/lib/desktop/spaces'
import type {DesktopCreationIntent} from '@/lib/desktop/new-agent'

vi.mock('@rerun/ui/foreman',()=>({Orb:()=>null}))
// Keep the actual App, original description form and IsoGrid. The chat leaf records the exact
// requested first session and gives the surrounding panel a draft whose DOM lifetime we assert.
vi.mock('./DesktopChatTabs',()=>({DesktopChatTabs:({agent,requested}:ComponentProps<typeof import('./DesktopChatTabs').DesktopChatTabs>)=><div data-created-chat={agent.id} data-requested-session={requested&&'id' in requested?requested.id:''}><textarea aria-label="Existing chat draft" defaultValue="Original unsent draft"/></div>}))
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333',newOwner='44444444-4444-4444-8444-444444444444'
const existing={id:owner,name:'Original',description:'Original job',createdAt:'2026-01-01',updatedAt:'2026-01-01'}
const created={id:newOwner,name:'Billing Replies',description:'',createdAt:'2026-01-02',updatedAt:'2026-01-02'}
const initialBoard=():DesktopBoardState=>({revision:1,spaces:[{id:a,name:'Original Box',col_start:0,row_start:0,col_end:7,row_end:7},{id:b,name:'New Box',col_start:10,row_start:0,col_end:17,row_end:7}],placements:[{agentId:owner,spaceId:a,col:0,row:0}]})
type Submitted={intent:DesktopCreationIntent;position:{col:number;row:number};spaceId:string}
let root:Root|undefined
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.unstubAllGlobals()})
const button=(label:string)=>{const value=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()===label);if(!value)throw new Error(`Missing ${label}`);return value}
const click=async(node:HTMLElement)=>{await act(async()=>node.click())}
const activate=async(node:HTMLElement)=>{await act(async()=>{node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})}
const edit=async(field:HTMLTextAreaElement,text:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,text);field.dispatchEvent(new Event('input',{bubbles:true}))})}

async function mount(options:{pending?:Submitted&{phase?:'reserved'|'created'|'started'};loseFirstReply?:boolean;pendingOwnerInRoster?:boolean;pendingRead?:Promise<void>}={}){
 let board=initialBoard(),pending=options.pending??null,posts=0
 if(options.pendingOwnerInRoster && pending)board={...board,placements:[...board.placements,{agentId:newOwner,spaceId:pending.spaceId,...pending.position}]}
 const requests:Submitted[]=[],acknowledged:string[]=[],unexpected:string[]=[],sessionReads:string[]=[]
 const drafts=createDesktopDraftFixture(),recent=createDesktopRecentFixture()
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  if(url==='/api/desktop/new-agent'){
   if(!init?.method){await options.pendingRead;return Response.json({pending})}
   if(init.method==='PATCH'){acknowledged.push(JSON.parse(String(init.body)).requestId);pending=null;return Response.json({acknowledged:true})}
   const body=JSON.parse(String(init.body)) as Submitted;requests.push(body);pending=body
   board={...board,revision:2,placements:[...board.placements.filter(item=>item.agentId!==newOwner),{agentId:newOwner,spaceId:body.spaceId,...body.position}]}
   if(options.loseFirstReply && ++posts===1)throw new Error('Lost successful response')
   return Response.json({agent:{...created,name:body.intent.name,position:body.position,spaceId:body.spaceId},sessionId:'first-chat'})
  }
  if(url==='/api/desktop/new-agent/read')return Response.json({reply:JSON.stringify({name:created.name,apps:[],schedule:null})})
  const shared=recent.handle(url,init)??drafts.handle(url,init);if(shared)return shared
  if(url==='/api/desktop/spaces')return Response.json({board})
  if(url==='/api/desktop/settings')return Response.json({connections:[],default:null})
  if(url==='/api/desktop/board-activity')return Response.json({agents:{[owner]:'idle',[newOwner]:'idle'}})
  if(url==='/api/desktop/pending-inbox')return Response.json({items:[],unavailableAgentIds:[],checkedAt:'2026-11-04T00:00:00Z'})
  if(url==='/api/desktop/completions')return Response.json({items:[],unavailableAgentIds:[],enabledAt:'2026-11-04T00:00:00Z',checkedAt:'2026-11-04T00:00:00Z',nextCursor:null})
  if(url.includes('/sessions')){sessionReads.push(url);const agentId=url.includes(owner)?owner:newOwner;return Response.json({sessions:[{id:agentId===owner?'original-chat':'first-chat',agentId,title:'First chat',createdAt:'',updatedAt:''}]})}
  unexpected.push(`${init?.method??'GET'} ${url}`);throw new Error('Unexpected request')
 }))
 root=createRoot(document.body.appendChild(document.createElement('div')))
 await act(async()=>root!.render(<MotionConfig reducedMotion="always"><DesktopApp initialData={{profile:{id:1,displayName:'Local'},workspace:{id:1,name:'Workspace'},theme:'system',connections:[],default:null,agents:options.pendingOwnerInRoster?[existing,created]:[existing],board}}/></MotionConfig>))
 return {requests,acknowledged,unexpected,sessionReads}
}

async function describe(text:string){
 const field=document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
 expect(field).toBeTruthy();await edit(field,text)
 await click(document.querySelector<HTMLButtonElement>('[data-aim="create"]')!)
 await act(async()=>{})
}

it('writes nothing before placement, preserves the existing chat draft on Cancel, then opens the exact created first chat',async()=>{
 const fixture=await mount()
 await activate(document.querySelector<HTMLElement>('[aria-label="Open chat with Original"]')!)
 const original=document.querySelector<HTMLTextAreaElement>('[aria-label="Existing chat draft"]')!
 await edit(original,'Keep this exact unsent draft')
 await click(button('Add coworker'));await describe('Draft a reply for every new billing question.')
 expect(document.querySelector('[role="dialog"]')).toBeNull()
 expect(button('Place coworker')).toBeTruthy();expect(fixture.requests).toEqual([])
 expect(original.isConnected).toBe(true);expect(original.value).toBe('Keep this exact unsent draft')
 await click(button('Cancel'))
 expect(fixture.requests).toEqual([])
 await activate(document.querySelector<HTMLElement>('[aria-label="Open chat with Original"]')!)
 expect(document.querySelector('[aria-label="Existing chat draft"]')).toBe(original)
 await click(button('Add coworker'));const text='Draft a reply for every new billing question.';await describe(text)
 await click(button('Place coworker'))
 expect(fixture.requests).toHaveLength(1)
 expect(fixture.requests[0].intent.kickoff).toBe(text)
 expect(document.querySelector(`[data-created-chat="${newOwner}"]`)?.getAttribute('data-requested-session')).toBe('first-chat')
 expect(fixture.acknowledged).toEqual([fixture.requests[0].intent.requestId])
 expect(fixture.unexpected).toEqual([])
})

it('keeps an empty-Box invitation in that Box and retries a lost response at its exact original spot',async()=>{
 const fixture=await mount({loseFirstReply:true})
 const invited=document.querySelector<HTMLElement>('[aria-label="Box New Box, 2 of 2"]')!
 await activate(invited);await describe('Read new billing tickets and prepare a draft.')
 expect(fixture.requests).toEqual([])
 await click(button('Place coworker'))
 expect(fixture.requests[0].spaceId).toBe(b)
 expect(fixture.requests[0].position).toEqual({col:10,row:0})
 expect(button('Cancel').disabled).toBe(true)
 expect(document.body.textContent).not.toContain('Start over')
 await click(button('Retry'))
 expect(fixture.requests).toHaveLength(2);expect(fixture.requests[1]).toEqual(fixture.requests[0])
 expect(fixture.acknowledged).toEqual([fixture.requests[0].intent.requestId])
 expect(fixture.unexpected).toEqual([])
})

it('restores an unresolved creation on startup without another description or placement',async()=>{
 const pending:Submitted={intent:{requestId:'55555555-5555-4555-8555-555555555555',name:created.name,kickoff:'Use my exact original description.',suggestionId:null,scheduled:false},spaceId:b,position:{col:12,row:2}}
 const fixture=await mount({pending})
 expect(document.querySelector('[role="dialog"]')).toBeNull();expect(button('Cancel').disabled).toBe(true)
 await click(button('Retry'))
 expect(fixture.requests).toEqual([pending]);expect(fixture.acknowledged).toEqual([pending.intent.requestId])
 expect(document.querySelector(`[data-created-chat="${newOwner}"]`)?.getAttribute('data-requested-session')).toBe('first-chat')
 expect(fixture.unexpected).toEqual([])
})

it('keeps a reserved roster owner out of workspace navigation until the exact first chat is confirmed',async()=>{
 let finishRead!:()=>void
 const pendingRead=new Promise<void>(resolve=>{finishRead=resolve})
 const pending={intent:{requestId:'55555555-5555-4555-8555-555555555555',name:created.name,kickoff:'Use my exact original description.',suggestionId:null,scheduled:false},spaceId:b,position:{col:12,row:2},phase:'created' as const}
 const fixture=await mount({pending,pendingOwnerInRoster:true,pendingRead})
 const modelSettings=()=>document.querySelector<HTMLButtonElement>('[title="Open model settings"]')!
 const openMenu=async()=>{
  const pill=document.querySelector<HTMLButtonElement>('[aria-label="Workspace menu, Workspace"]')!
  await act(async()=>{pill.focus();pill.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})
 }
 const entry=(name:string)=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.trim()===name)!
 await openMenu()
 expect(entry(created.name).getAttribute('aria-disabled')).toBe('true')
 expect(modelSettings().disabled).toBe(true)
 await click(entry(created.name));expect(fixture.sessionReads).toEqual([])
 await act(async()=>finishRead())
 // Restoring placement moves focus to its original board action and closes the menu.
 if(!entry(created.name))await openMenu()
 expect(entry(created.name).getAttribute('aria-disabled')).toBe('true')
 expect(entry('Workspace settings').getAttribute('aria-disabled')).toBe('true')
 expect(entry('Control center').getAttribute('aria-disabled')).toBe('true')
 await click(entry(created.name));expect(fixture.sessionReads).toEqual([])
 await act(async()=>{document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))})
 // Recovery can reconnect a provider, but cannot enter the unfinished owner's initial tab.
 expect(modelSettings().disabled).toBe(false)
 await click(modelSettings());expect(document.querySelector('#desktop-api-key')).not.toBeNull()
 await click(button('Team board'))
 await click(button('Retry'))
 expect(fixture.requests).toEqual([{intent:pending.intent,position:pending.position,spaceId:pending.spaceId}])
 expect(fixture.sessionReads).toEqual([`/api/desktop/agents/${newOwner}/sessions`])
 expect(document.querySelector(`[data-created-chat="${newOwner}"]`)?.getAttribute('data-requested-session')).toBe('first-chat')
 expect(fixture.acknowledged).toEqual([pending.intent.requestId])
 expect(fixture.unexpected).toEqual([])
})
