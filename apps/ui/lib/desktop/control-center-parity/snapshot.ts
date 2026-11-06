import type {DesktopAgentView} from '@/components/desktop/DesktopApp'
import type {DesktopBoardState} from '@/lib/desktop/spaces'
import type {DesktopControlCenterChats} from '@/lib/desktop/control-center-chats'
import type {DesktopConversationHit} from '@/lib/desktop/chat-search'
import {parseDesktopForemanChatRef} from '@/lib/desktop/foreman-client/identity'
import type {ParitySnapshot} from './types'
export function projectParitySnapshot(input:{workspaceId:string;workspaceRevision:string;agents:DesktopAgentView[];board:DesktopBoardState;chats:DesktopControlCenterChats[];savedHits?:DesktopConversationHit[];pendingAgentIds:ReadonlySet<string>;foreman:unknown;quitting:boolean;blocked:boolean}):ParitySnapshot{
 const coworkers=input.agents.map(agent=>{
  const spaceId=input.board.placements.find(p=>p.agentId===agent.id)?.spaceId??null
  return {id:agent.id,name:agent.name,enabled:agent.enabled!==false,spaceId,pending:input.pendingAgentIds.has(agent.id),revision:JSON.stringify([agent.id,agent.updatedAt,agent.enabled!==false,spaceId])}
 })
 const owners=new Set(coworkers.map(a=>a.id)),chats:ParitySnapshot['chats']=[],seen=new Set<string>()
 const append=(agentId:string,sessionId:string|null,tabUid:string|null,title:string,open:boolean)=>{
  if(!owners.has(agentId)||sessionId===null&&tabUid===null)throw new Error('Unexpected chat owner')
  const key=JSON.stringify([agentId,sessionId,tabUid]);if(seen.has(key))return;seen.add(key)
  chats.push({agentId,sessionId,tabUid,title,open,revision:JSON.stringify([agentId,sessionId,tabUid,title,open])})
 }
 for(const list of input.chats){
  if(!owners.has(list.agentId)||list.openChats.some(c=>c.agentId!==list.agentId)||list.recentChats.some(c=>c.agentId!==list.agentId))throw new Error('Unexpected chat owner')
  for(const chat of list.openChats)append(chat.agentId,chat.sessionId,chat.tabUid,chat.title,true)
  if(list.recentStatus==='ok')for(const chat of list.recentChats)if(!chats.some(c=>c.agentId===chat.agentId&&c.sessionId===chat.id))append(chat.agentId,chat.id,null,chat.title,false)
 }
 for(const hit of input.savedHits??[])if(!chats.some(c=>c.agentId===hit.agentId&&c.sessionId===hit.id))append(hit.agentId,hit.id,null,hit.title,false)
 const foreman=parseDesktopForemanChatRef(input.foreman)
 if(foreman&&foreman.workspaceId!==input.workspaceId)throw new Error('Unexpected Foreman workspace')
 return {workspace:{id:input.workspaceId,revision:input.workspaceRevision},quitting:input.quitting,blocked:input.blocked,coworkers,boxes:input.board.spaces.map(box=>({id:box.id,name:box.name,revision:JSON.stringify([box.id,box.name,box.col_start,box.row_start,box.col_end,box.row_end])})),chats,foreman}
}
