import { buildDesktopControlCommands } from '../control-center'
import type {ControlSection,ControlRow} from '@/components/control-center/types'
import {isDesktopCoworkerPanel} from '@/lib/desktop/coworker-panel'
import {AGENT_TABS} from '@/components/agent/agent-tabs'
import {buildControlCommands,CONTROL_COMMAND_IDS,type ControlCommandId} from '@/lib/control-center/commands'
import {parseQuery,searchItems} from '@/lib/control-center/search'
import {BellIcon,BoxIcon,BrainIcon,CirclePlusIcon,FocusCenterIcon,FolderIcon,GridIcon,HeadsetIcon,KeyboardIcon,KeyIcon,LockKeyholeIcon,MegaphoneIcon,MessageCircle,MessageCircleQuestionIcon,MonitorIcon,MoonIcon,SettingsIcon,SunIcon,UserRoundIcon,UsersIcon,CreditCardIcon} from '@/lib/icons'
import type {ParityActions,ParityCommand,ParityPage,ParitySnapshot,ParityTarget} from './types'
const icons:Record<ControlCommandId,Extract<ControlRow['leading'],{kind:'icon'}>['icon']>={new_agent:CirclePlusIcon,browse_templates:GridIcon,new_box:BoxIcon,ask_assistant:MessageCircleQuestionIcon,contact_support:HeadsetIcon,recenter_board:FocusCenterIcon,toggle_theme:SunIcon,workspace:SettingsIcon,members:UsersIcon,billing:CreditCardIcon,ai_providers:LockKeyholeIcon,api_keys:KeyIcon,company_brain:BrainIcon,shared_files:FolderIcon,account:UserRoundIcon,notifications:BellIcon,shortcuts:KeyboardIcon,whats_new:MegaphoneIcon}
export const HOSTED_CONTROL_COMMANDS=new Set(['contact_support','members','billing','account'])
const workspace=(s:ParitySnapshot):Extract<ParityTarget,{kind:'workspace'}>=>({kind:'workspace',workspaceId:s.workspace.id,revision:s.workspace.revision})
const coworker=(s:ParitySnapshot,id:string):Extract<ParityTarget,{kind:'coworker'}>|null=>{const a=s.coworkers.find(a=>a.id===id);return a?{kind:'coworker',workspaceId:s.workspace.id,agentId:a.id,revision:a.revision}:null}
export function buildParityCommands(snapshot:ParitySnapshot,page:ParityPage,query:string,actions:ParityActions,options:{darkTheme?:boolean;hasChangelog?:boolean;includeOmitted?:boolean}={}):ParityCommand[]{
 const {text,scope}=parseQuery(query),commands:ParityCommand[]=[]
 if(snapshot.quitting||snapshot.blocked)return commands
 const add=(command:ParityCommand)=>{const state=actions.capability(command.intent,snapshot);if(state.state!=='omit'||options.includeOmitted)commands.push({...command,...(state.state==='omit'?{omitted:true}:{}),...(state.state==='unavailable'?{disabledReason:state.reason||'This action is unavailable on this Mac.'}:{})})}
 if(page.kind==='root'){
  if(scope==='agents')return []
  for(const command of buildControlCommands({isSandbox:false,apiEntitled:false,needsMachineReason:null,assistantReady:!!snapshot.foreman,hasChangelog:!!options.hasChangelog,darkTheme:!!options.darkTheme})){
   if(HOSTED_CONTROL_COMMANDS.has(command.id))continue
   if(command.id==='ask_assistant'){
    if(snapshot.foreman)add({key:'ask_assistant',label:text?'Ask Rerun':command.label,description:text?`“${query.trim()}”`:undefined,icon:text?{kind:'assistant'}:{kind:'icon',icon:icons.ask_assistant},group:'actions',intent:{kind:'assistant',target:workspace(snapshot),chat:snapshot.foreman,draft:text?query.trim():''}})
   }else add({key:command.id,label:command.label,keywords:command.keywords,icon:{kind:'icon',icon:command.id==='toggle_theme'&&!options.darkTheme?MoonIcon:icons[command.id]},group:command.group,intent:{kind:'global',command:command.id,target:workspace(snapshot)}})
  }
 }else if(page.kind==='coworker'){
  const target=coworker(snapshot,page.agentId);if(!target)return []
  for(const tab of AGENT_TABS){
   if(!isDesktopCoworkerPanel(tab.id))continue
   if(tab.id==='actions'&&!snapshot.coworkers.find(a=>a.id===page.agentId)?.pending)continue
   add({key:`panel:${tab.id}`,label:tab.label,description:tab.id==='triggers'?'URLs that start a run when called on this Mac':tab.description,icon:{kind:'icon',icon:tab.icon},group:'open',intent:{kind:'panel',panel:tab.id,target}})
  }
  add({key:'desktop',label:'Desktop',description:"Take control of this coworker's screen",keywords:['screen','browser','computer'],icon:{kind:'icon',icon:MonitorIcon},group:'actions',intent:{kind:'desktop',target},disabledReason:!snapshot.coworkers.find(a=>a.id===page.agentId)?.enabled?'This coworker is off.':undefined})
  add({key:'coworker-notifications',label:'Notifications',description:'When this agent reaches you',keywords:['alerts'],icon:{kind:'icon',icon:BellIcon},group:'actions',intent:{kind:'notifications',target}})
  for(const chat of snapshot.chats.filter(c=>c.agentId===page.agentId))add({key:`chat:${chat.tabUid??chat.sessionId}`,label:chat.title,icon:{kind:'icon',icon:MessageCircle},group:'conversations',intent:{kind:'chat',target:{kind:'chat',workspaceId:snapshot.workspace.id,agentId:chat.agentId,sessionId:chat.sessionId,tabUid:chat.tabUid,revision:chat.revision}}})
 }else if(page.kind==='move'){
  const target=coworker(snapshot,page.agentId),source=snapshot.coworkers.find(a=>a.id===page.agentId)?.spaceId;if(!target||!source)return []
  for(const box of snapshot.boxes.filter(b=>b.id!==source))add({key:`move:${box.id}`,label:box.name,icon:{kind:'icon',icon:BoxIcon},group:'actions',intent:{kind:'move',target,sourceSpaceId:source,destination:{kind:'box',workspaceId:snapshot.workspace.id,spaceId:box.id,revision:box.revision}}})
 }
 const assistant=commands.filter(command=>command.key==='ask_assistant'&&text&&scope==='all')
 return [...searchItems(commands.filter(command=>!(command.key==='ask_assistant'&&text)),text),...assistant]
}
export function parityCommandSections(commands:ParityCommand[],execute:(command:ParityCommand)=>void,page?:ParityPage):ControlSection[]{
 commands=commands.filter(c=>!c.omitted)
 const rows=(items:ParityCommand[]):ControlRow[]=>items.map(command=>({id:`parity-${command.key}`,label:command.label,detail:command.description,leading:command.icon,disabledReason:command.disabledReason,onSelect:()=>execute(command)}))
 if(page?.kind==='move')return [{id:'move',heading:'Move to',rows:rows(commands)}]
 const sections:ControlSection[]=[]
 for(const [group,heading] of [['open','Open'],['actions','Actions'],['settings','Settings']] as const){const items=commands.filter(c=>c.group===group&&!(c.key==='ask_assistant'&&c.icon.kind==='assistant'));if(items.length)sections.push({id:group,heading,rows:rows(items)})}
 for(const [open,heading] of [[true,'Open chats'],[false,'Recent conversations']] as const){
  const items=commands.filter(c=>c.intent.kind==='chat'&&Boolean(c.intent.target.tabUid)===open)
  if(items.length)sections.push({id:open?'open-chats':'recent-chats',heading,rows:rows(items)})
 }
 const assistant=commands.filter(c=>c.key==='ask_assistant'&&c.icon.kind==='assistant')
 if(assistant.length)sections.push({id:'assistant',heading:'Assistant',rows:rows(assistant)})
 return sections
}
const aliases:Record<string,string>={'command-add_coworker':'new_agent','command-new_box':'new_box','command-company_brain':'company_brain','command-shared_files':'shared_files','command-model_settings':'ai_providers','command-workspace_settings':'workspace','command-recenter_board':'recenter_board','command-toggle_theme':'toggle_theme','command-notifications':'notifications','command-shortcuts':'shortcuts','coworker-notifications':'coworker-notifications','agent-desktop':'desktop','coworker-desktop':'desktop'}
export function paritySemanticKey(id:string){if(id.startsWith('parity-'))return id.slice(7);if(id.startsWith('tab-'))return `panel:${id.slice(4)}`;if(id.startsWith('open-chat-'))return `chat:${id.slice(10)}`;if(id.startsWith('recent-chat-'))return `chat:${id.slice(12)}`;if(id.includes('-conversation-'))return `chat:${id.slice(id.indexOf('-conversation-')+14)}`;if(id.startsWith('move-'))return `move:${id.slice(5)}`;return aliases[id]??(id==='ask-assistant'?'ask_assistant':id.startsWith('command-')?id.slice(8):id)}
export function mergeParitySections(existing:ControlSection[],additions:ControlSection[],query=''):ControlSection[]{
 const seen=new Set(existing.flatMap(s=>s.rows.map(r=>paritySemanticKey(r.id))))
 const result=existing.map(section=>({...section,rows:[...section.rows]}))
 for(const section of additions){
  const rows=section.rows.filter(row=>{const key=paritySemanticKey(row.id);if(seen.has(key))return false;seen.add(key);return true})
  const group=result.find(s=>s.heading===section.heading)
  if(group)group.rows.push(...rows);else if(rows.length)result.push({...section,rows})
 }
 const metadata=buildControlCommands({isSandbox:false,apiEntitled:false,needsMachineReason:null,assistantReady:true,hasChangelog:true,darkTheme:false})
 for(const section of [...result]){
  section.rows=section.rows.filter(row=>{
   const command=metadata.find(c=>c.id===paritySemanticKey(row.id))
   if(!command||row.leading.kind==='assistant'||section.heading===(command.group==='actions'?'Actions':'Settings'))return true
   const heading=command.group==='actions'?'Actions':'Settings'
   let destination=result.find(group=>group.heading===heading)
   if(!destination){destination={id:command.group,heading,rows:[]};result.push(destination)}
   destination.rows.push(row);return false
  })
 }
 const desktopMetadata=buildDesktopControlCommands({brain:true,sharedFiles:true,addBox:true,shortcuts:true,notifications:true,workspaceSettings:true,recenterBoard:true,toggleTheme:true})
 const rank=(row:ControlRow)=>{
  const key=paritySemanticKey(row.id),tab=AGENT_TABS.findIndex(tab=>`panel:${tab.id}`===key)
  if(tab>=0)return tab
  const global=CONTROL_COMMAND_IDS.findIndex(id=>id===key)
  if(global>=0)return global
  if(key==='servers')return CONTROL_COMMAND_IDS.indexOf('api_keys')+0.5
  return key==='desktop'?0:['coworker-move','agent-move'].includes(key)?1:key==='coworker-notifications'?2:1000
 }
 const {text}=parseQuery(query)
 for(const section of result)if(['Actions','Settings','Open'].includes(section.heading)){
  section.rows.sort((a,b)=>rank(a)-rank(b))
  if(text)section.rows=searchItems(section.rows.map(row=>{
   const original=metadata.find(command=>command.id===paritySemanticKey(row.id))?.keywords??(paritySemanticKey(row.id)==='servers'?['machine','computer','remote','connection']:AGENT_TABS.filter(tab=>`panel:${tab.id}`===paritySemanticKey(row.id)).map(tab=>tab.description))
   // Preserve supported Mac aliases such as notification sound alongside the original catalog.
   const local=desktopMetadata.find(command=>`command-${command.id}`===row.id)?.keywords??[]
   return {...row,keywords:[...new Set([...original,...local])]}
  }),text)
 }
 return result.filter(section=>section.rows.length||section.loading)
}


export function gateExistingParitySections(existing:ControlSection[],snapshot:ParitySnapshot,page:ParityPage,actions:ParityActions):ControlSection[]{
 const commands=buildParityCommands(snapshot,page,'',actions,{includeOmitted:true}),byKey=new Map(commands.map(command=>[command.key,command]))
 return existing.map(section=>({...section,rows:section.rows.flatMap(row=>{
  const key=paritySemanticKey(row.id),command=byKey.get(key)
  if(HOSTED_CONTROL_COMMANDS.has(key)||command?.omitted||key==='ask_assistant'&&!snapshot.foreman||key==='panel:actions'&&page.kind==='coworker'&&!snapshot.coworkers.find(a=>a.id===page.agentId)?.pending)return []
  return [{...row,...(command?.disabledReason?{disabledReason:command.disabledReason}:{})}]
 })}))
}
