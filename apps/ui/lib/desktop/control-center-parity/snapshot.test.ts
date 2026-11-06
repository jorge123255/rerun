import {it,expect} from 'vitest'
import {projectParitySnapshot} from './snapshot'
const input={workspaceId:'workspace',workspaceRevision:'one',agents:[{id:'a',name:'Same',description:'',createdAt:'created',updatedAt:'updated',enabled:true},{id:'b',name:'Same',description:'',createdAt:'created',updatedAt:'updated',enabled:true}],board:{revision:1,spaces:[],placements:[]},chats:[{agentId:'a',openChats:[{agentId:'a',tabUid:'actual-draft',sessionId:null,title:'New chat'}],recentChats:[],recentStatus:'ok' as const,hasMore:false}],pendingAgentIds:new Set<string>(),foreman:null,quitting:false,blocked:false}
it('projects only actual persisted tabs and preserves their IDs across restore without creating sessions',()=>{
 const first=projectParitySnapshot(input),restored=projectParitySnapshot(structuredClone(input))
 expect(first).toEqual(restored)
 expect(first.chats).toHaveLength(1)
 expect(first.chats[0]).toMatchObject({sessionId:null,tabUid:'actual-draft',open:true,agentId:'a'})
 expect(projectParitySnapshot({...input,chats:[]}).chats).toEqual([])
})
it('rejects cross-owner chat rows rather than assigning them to the selected coworker',()=>{
 expect(()=>projectParitySnapshot({...input,chats:[{...input.chats[0]!,openChats:[{agentId:'b',tabUid:'actual-draft',sessionId:null,title:'New chat'}]}]})).toThrow('owner')
})
it('never adopts an unscoped or other-workspace Foreman identity',()=>{
 expect(()=>projectParitySnapshot({...input,foreman:{workspaceId:'other',chatId:'fmc_existingchat'}})).toThrow('Foreman workspace')
 expect(projectParitySnapshot({...input,foreman:{workspaceId:'workspace',chatId:'ordinary-conversation'}}).foreman).toBeNull()
})
