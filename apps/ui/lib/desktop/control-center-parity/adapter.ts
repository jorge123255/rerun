import type {ParityActions,ParityNavigationBindings,ParityIntent} from './types'
import {intentIsCurrent} from './authority'
export function createParityActions(read:ParityActions['read'],bindings:()=>ParityNavigationBindings,availability:ParityActions['capability']):ParityActions{
 const callback=(intent:ParityIntent)=>{
  const live=bindings()
  switch(intent.kind){
   case 'global':return live.global[intent.command]
   case 'panel':return live.panel
   case 'desktop':return live.desktop
   case 'notifications':return live.notifications
   case 'move':return live.move
   case 'assistant':return live.assistant
   case 'chat':return intent.target.tabUid?live.openTab:live.openSaved
  }
 }
 return {read,
  capability(intent,snapshot){const state=availability(intent,snapshot);return state.state==='ready'&&!callback(intent)?{state:'unavailable',reason:'This local action is not connected to its canonical handler.'}:state},
  async dispatch(intent,signal){
   signal.throwIfAborted();const snapshot=await read(signal);signal.throwIfAborted()
   if(!intentIsCurrent(intent,snapshot)||availability(intent,snapshot).state!=='ready'||!callback(intent))throw new Error('This command changed. Refresh the list and choose again.')
   const live=bindings(),execution={signal,workspaceId:intent.target.workspaceId,expectedRevision:intent.target.revision}
   // Every callback below is scoped to captured immutable IDs, never selectedAgentId.
   switch(intent.kind){
    case 'global':await live.global[intent.command]!(intent.target.workspaceId,execution);break
    case 'panel':await live.panel!(intent.target.agentId,intent.panel,execution);break
    case 'desktop':await live.desktop!(intent.target.agentId,execution);break
    case 'notifications':await live.notifications!(intent.target.agentId,execution);break
    case 'move':await live.move!(intent.target.agentId,intent.destination.spaceId,execution);break
    case 'assistant':await live.assistant!(intent.chat,intent.draft,execution);break
    case 'chat':{
     const chat=snapshot.chats.find(c=>c.agentId===intent.target.agentId&&c.sessionId===intent.target.sessionId&&c.tabUid===intent.target.tabUid&&c.revision===intent.target.revision)!
     if(chat.tabUid)await live.openTab!({agentId:chat.agentId,tabUid:chat.tabUid,sessionId:chat.sessionId,title:chat.title},execution)
     else if(chat.sessionId)await live.openSaved!({agentId:chat.agentId,id:chat.sessionId,title:chat.title,agentName:snapshot.coworkers.find(a=>a.id===chat.agentId)!.name},execution)
     else throw new Error('This draft tab is no longer open.')
     break
    }
   }
  },
 }
}
