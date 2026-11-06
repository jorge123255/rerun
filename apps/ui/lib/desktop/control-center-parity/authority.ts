import {CONTROL_COMMAND_IDS} from '@/lib/control-center/commands'
import {isDesktopCoworkerPanel} from '@/lib/desktop/coworker-panel'
import {parseDesktopForemanChatRef} from '@/lib/desktop/foreman-client/identity'
import type {ParitySnapshot,ParityTarget,ParityIntent} from './types'
export function targetIsCurrent(target:ParityTarget,snapshot:ParitySnapshot):boolean{
 if(snapshot.quitting||snapshot.blocked||target.workspaceId!==snapshot.workspace.id)return false
 if(target.kind==='workspace')return target.revision===snapshot.workspace.revision
 if(target.kind==='box')return snapshot.boxes.some(b=>b.id===target.spaceId&&b.revision===target.revision)
 if(!snapshot.coworkers.some(a=>a.id===target.agentId))return false
 if(target.kind==='coworker')return snapshot.coworkers.some(a=>a.id===target.agentId&&a.revision===target.revision)
 return snapshot.chats.some(c=>c.agentId===target.agentId&&c.sessionId===target.sessionId&&c.tabUid===target.tabUid&&c.revision===target.revision)
}
export function intentIsCurrent(intent:ParityIntent,snapshot:ParitySnapshot):boolean{
 if(!targetIsCurrent(intent.target,snapshot))return false
 if(intent.kind==='global'&&(!CONTROL_COMMAND_IDS.includes(intent.command)||['members','billing','api_keys','account','contact_support','ask_assistant'].includes(intent.command)))return false
 if(intent.kind==='panel'&&!isDesktopCoworkerPanel(intent.panel))return false
 if(intent.kind==='desktop'&&!snapshot.coworkers.find(a=>a.id===intent.target.agentId)?.enabled)return false
 if(intent.kind==='panel'&&intent.panel==='actions'&&!snapshot.coworkers.find(a=>a.id===intent.target.agentId)?.pending)return false
 if(intent.kind==='move')return targetIsCurrent(intent.destination,snapshot)&&snapshot.coworkers.find(a=>a.id===intent.target.agentId)?.spaceId===intent.sourceSpaceId&&intent.sourceSpaceId!==intent.destination.spaceId
 if(intent.kind==='assistant')return !!parseDesktopForemanChatRef(intent.chat)&&snapshot.foreman?.workspaceId===intent.chat.workspaceId&&snapshot.foreman.chatId===intent.chat.chatId&&intent.chat.workspaceId===snapshot.workspace.id
 return true
}
