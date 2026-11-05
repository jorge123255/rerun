import {createHash} from 'node:crypto'
import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const fs=vi.hoisted(()=>({save:vi.fn(),create:vi.fn(),read:vi.fn(),location:vi.fn()}))
vi.mock('../coworker-files',()=>({saveCoworkerFile:fs.save,importCoworkerFile:fs.create}))
vi.mock('../private-file-tools/snapshot',()=>({privateFileLocation:fs.location,readPrivateSnapshot:fs.read}))
import {nativeWritebackSchema,nativeWritebackService,type NativeBundle} from './service'
import type {DesktopRuntime} from '../runtime'
const clients:ReturnType<typeof createClient>[]=[]
afterEach(()=>{for(const db of clients.splice(0))db.close();vi.resetAllMocks()})
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
async function setup(){
 const db=createClient({url:'file::memory:'});clients.push(db);await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+nativeWritebackSchema)
 let granted=true
 const authorize=vi.fn(async(_identity:unknown,action:string)=>{if(action==='apply'&&!granted)throw new Error('writeback off');return {owner:'owner',runtime:{dataRoot:'/example',launchNonce:'launch'} as DesktopRuntime,workspaceRoot:'/example/private'}})
 const service=nativeWritebackService(db,authorize)
 fs.location.mockResolvedValue({directories:[{path:'/example/private',dev:1n,ino:2n}],target:'/example/private/a.md'})
 fs.read.mockResolvedValue({version:'version-before',identity:'3:4',content:'before',hash:'publisher-hash'})
 const bundle:NativeBundle={id:'b531ced2-5bbe-4490-b441-b9405e2eeb45',engineAgentId:'engine',sessionId:'session',runId:'run',files:[{path:'a.md',before:{text:'before',sha256:sha('before'),identity:'3:4',version:'version-before'},after:'after',afterHash:sha('after'),parents:[{path:'',identity:'1:2'}]}]}
 await service.capture(bundle,new AbortController().signal)
 return {db,service,bundle,authorize,revoke:()=>{granted=false}}
}
it('preserves immutable review across restart and applies only its exact digest once',async()=>{
 const {db,service,bundle,authorize}=await setup(),signal=new AbortController().signal
 const item=(await service.list('owner',signal)).files[0]
 await expect(service.decide('owner',bundle.id,item.path,'0'.repeat(64),'apply',signal)).rejects.toThrow('Reviewed bytes')
 expect(await nativeWritebackService(db,authorize).decide('owner',bundle.id,item.path,item.digest,'apply',signal)).toEqual({state:'saved'})
 expect(await service.decide('owner',bundle.id,item.path,item.digest,'apply',signal)).toEqual({state:'saved'})
 expect(fs.save).toHaveBeenCalledTimes(1)
 await expect(service.capture({...bundle,files:[{...bundle.files[0],after:'later',afterHash:sha('later')}]},signal)).rejects.toThrow('identity reused')
})
it('refuses source drift and revoked permission, and reject never touches originals',async()=>{
 const {service,bundle,revoke}=await setup(),signal=new AbortController().signal,item=(await service.list('owner',signal)).files[0]
 revoke();await expect(service.decide('owner',bundle.id,item.path,item.digest,'apply',signal)).rejects.toThrow('writeback off')
 expect(await service.decide('owner',bundle.id,item.path,item.digest,'reject',signal)).toEqual({state:'rejected'})
 expect(fs.save).not.toHaveBeenCalled();expect(fs.create).not.toHaveBeenCalled()
})
it('records a conflict before publisher entry when source version drifted',async()=>{
 const {service,bundle}=await setup(),signal=new AbortController().signal,item=(await service.list('owner',signal)).files[0]
 fs.read.mockResolvedValue({version:'changed',identity:'3:4',content:'before',hash:'publisher-hash'})
 expect(await service.decide('owner',bundle.id,item.path,item.digest,'apply',signal)).toEqual({state:'conflict'})
 expect(fs.save).not.toHaveBeenCalled()
})
