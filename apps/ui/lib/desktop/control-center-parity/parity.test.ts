import {it,expect,vi} from 'vitest'
import {AGENT_TABS} from '@/components/agent/agent-tabs'
import {buildParityCommands,parityCommandSections,mergeParitySections,gateExistingParitySections} from './commands'
import {createParityController} from './controller'
import {createParityActions} from './adapter'
import {intentIsCurrent} from './authority'
import type {ParityActions,ParitySnapshot} from './types'
const fixture=():ParitySnapshot=>({workspace:{id:'workspace',revision:'one'},blocked:false,quitting:false,coworkers:[{id:'a',revision:'a1',name:'Same name',spaceId:'box1',enabled:true,pending:false},{id:'b',revision:'b1',name:'Same name',spaceId:'box2',enabled:true,pending:false}],boxes:[{id:'box1',revision:'box1-v1',name:'One'},{id:'box2',revision:'box2-v1',name:'Two'}],chats:[{agentId:'a',sessionId:null,tabUid:'draft-a',revision:'chat-v1',title:'Same title',open:true},{agentId:'b',sessionId:'b-chat',tabUid:null,revision:'chat-v2',title:'Same title',open:false}],foreman:{workspaceId:'workspace',chatId:'fmc_existingchat'}})
function actions(snapshot:ParitySnapshot):ParityActions{return {read:async()=>structuredClone(snapshot),capability:()=>({state:'ready'}),dispatch:vi.fn(async()=>{})}}
it('reuses original method order/labels and does not manufacture destructive Control Center rows',()=>{
 const snapshot=fixture(),commands=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',actions(snapshot))
 expect(commands.filter(c=>c.group==='open').map(c=>c.label)).toEqual(AGENT_TABS.filter(tab=>tab.id!=='actions').map(tab=>tab.label))
 expect(commands.some(c=>c.key==='desktop')).toBe(true)
 expect(commands.some(c=>/delete|rename|share|duplicate|mark.*read/i.test(c.label))).toBe(false)
 expect(commands.filter(c=>c.intent.kind==='chat').map(c=>c.intent.target)).toEqual([{kind:'chat',workspaceId:'workspace',agentId:'a',sessionId:null,tabUid:'draft-a',revision:'chat-v1'}])
})
it('has original templates/assistant ordering, preserves query Ask last, and omits hosted actions',()=>{
 const snapshot=fixture(),commands=buildParityCommands(snapshot,{kind:'root'},'',actions(snapshot))
 expect(commands.slice(0,4).map(c=>c.key)).toEqual(['new_agent','browse_templates','new_box','ask_assistant'])
 expect(commands.some(c=>['members','billing','api_keys','account','contact_support'].includes(c.key))).toBe(false)
 const query=buildParityCommands(snapshot,{kind:'root'},'find my work',actions(snapshot))
 const sections=parityCommandSections(query,()=>{})
 expect(sections.at(-1)?.heading).toBe('Assistant')
 expect(sections.at(-1)?.rows[0]?.label).toBe('Ask Rerun')
})
it('does not duplicate accepted panels and applies unavailable trigger authority to existing rows',()=>{
 const snapshot=fixture(),ports=actions(snapshot)
 ports.capability=intent=>intent.kind==='panel'&&intent.panel==='triggers'?{state:'unavailable',reason:'Root acceptance pending.'}:{state:'ready'}
 const commands=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports)
 const files=commands.find(c=>c.key==='panel:files')!,triggers=commands.find(c=>c.key==='panel:triggers')!
 const existing=[{id:'open',heading:'Open',rows:[{id:'tab-files',label:files.label,leading:files.icon,onSelect:()=>{}},{id:'tab-triggers',label:triggers.label,leading:triggers.icon,onSelect:()=>{}}]}]
 const gated=gateExistingParitySections(existing,snapshot,{kind:'coworker',agentId:'a'},ports)
 const merged=mergeParitySections(gated,parityCommandSections(commands,()=>{}))
 expect(merged.flatMap(s=>s.rows).filter(r=>r.label===files.label)).toHaveLength(1)
 expect(merged.flatMap(s=>s.rows).find(r=>r.id==='tab-triggers')?.disabledReason).toBe('Root acceptance pending.')
})
it('failed dispatch remains retryable and does not reset any external navigation',async()=>{
 const snapshot=fixture(),ports=actions(snapshot),dispatch=vi.fn<ParityActions['dispatch']>().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(undefined);ports.dispatch=dispatch
 const controller=createParityController(ports);controller.open()
 const command=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports).find(c=>c.key==='panel:files')!
 expect(await controller.execute(command)).toBe(false);expect(controller.getSnapshot().busy).toBe(false);expect(controller.getSnapshot().open).toBe(true)
 expect(await controller.execute(command)).toBe(true);expect(dispatch).toHaveBeenCalledTimes(2)
})
it('Escape/query/workspace change stops late search execution before any callback',async()=>{
 const snapshot=fixture(),ports=actions(snapshot);let resolve!:(s:ParitySnapshot)=>void
 ports.read=()=>new Promise(r=>{resolve=r})
 const controller=createParityController(ports);controller.open()
 const command=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports).find(c=>c.key==='panel:files')!
 const pending=controller.execute(command);controller.close();resolve(snapshot)
 expect(await pending).toBe(false);expect(ports.dispatch).not.toHaveBeenCalled()
})
it('checks exact owner/session and rejects disabled screen, deleted target and changed Box membership',()=>{
 const snapshot=fixture(),ports=actions(snapshot),commands=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports)
 const desktop=commands.find(c=>c.key==='desktop')!;snapshot.coworkers[0]!.enabled=false
 expect(intentIsCurrent(desktop.intent,snapshot)).toBe(false)
 const chat=commands.find(c=>c.intent.kind==='chat')!;snapshot.chats[0]!.sessionId='first-send-bound'
 expect(intentIsCurrent(chat.intent,snapshot)).toBe(false)
 const move=buildParityCommands(snapshot,{kind:'move',agentId:'a'},'',ports)[0]!
 snapshot.coworkers[0]!.spaceId='box2';expect(intentIsCurrent(move.intent,snapshot)).toBe(false)
 snapshot.coworkers=[];expect(intentIsCurrent(chat.intent,snapshot)).toBe(false)
})
it('real callback adapter rechecks current data and never falls back to a sibling with the same title/name',async()=>{
 const snapshot=fixture(),openTab=vi.fn(),panel=vi.fn()
 const ports=createParityActions(async()=>snapshot,()=>({global:{},openTab,panel}),()=>({state:'ready'}))
 const chat=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports).find(c=>c.intent.kind==='chat')!
 snapshot.chats=snapshot.chats.filter(c=>c.agentId!=='a')
 await expect(ports.dispatch(chat.intent,new AbortController().signal)).rejects.toThrow('changed')
 expect(openTab).not.toHaveBeenCalled();expect(panel).not.toHaveBeenCalled()
})
it('Back and reopening change only palette pages and query',()=>{
 const controller=createParityController(actions(fixture()));controller.open();controller.drill({kind:'box',spaceId:'box1'});controller.query('text');controller.back()
 expect(controller.getSnapshot().pages).toEqual([{kind:'root'}]);expect(controller.getSnapshot().query).toBe('')
 controller.close();controller.open();expect(controller.getSnapshot().pages).toEqual([{kind:'root'}])
})
it.each(['query','drill','back'] as const)('a %s transition invalidates old asynchronous command selection',async kind=>{
 const snapshot=fixture(),ports=actions(snapshot);let resolve!:(s:ParitySnapshot)=>void
 ports.read=()=>new Promise(r=>{resolve=r})
 const controller=createParityController(ports);controller.open()
 const command=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',ports).find(c=>c.key==='panel:files')!
 const pending=controller.execute(command)
 if(kind==='query')controller.query('new query');else if(kind==='drill')controller.drill({kind:'box',spaceId:'box2'});else controller.back()
 resolve(snapshot);expect(await pending).toBe(false);expect(ports.dispatch).not.toHaveBeenCalled()
})
it('a no-longer-pending To handle row never answers or opens another owner',()=>{
 const snapshot=fixture();snapshot.coworkers[0]!.pending=true
 const row=buildParityCommands(snapshot,{kind:'coworker',agentId:'a'},'',actions(snapshot)).find(c=>c.key==='panel:actions')!
 snapshot.coworkers[0]!.pending=false
 expect(intentIsCurrent(row.intent,snapshot)).toBe(false)
})
