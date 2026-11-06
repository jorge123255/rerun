import {mkdtemp,rm,realpath,lstat,rename,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {afterEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({root:'',loseAcknowledgement:false}))
vi.mock('../../config/paths.js',()=>({dataDir:()=>state.root}))
vi.mock('../skill-publication-native.js',()=>({
 acquireSkillLease:async()=>({assertCurrent(){},release:async()=>{}}),
 renameSkillEntry:async(directory:string,parent:{dev:bigint;ino:bigint},source:string,identity:{dev:bigint;ino:bigint},destination:string)=>{
  const dir=await lstat(directory,{bigint:true}),before=await lstat(join(directory,source),{bigint:true})
  expect([dir.dev,dir.ino,before.dev,before.ino]).toEqual([parent.dev,parent.ino,identity.dev,identity.ino])
  await expect(lstat(join(directory,destination))).rejects.toMatchObject({code:'ENOENT'})
  await rename(join(directory,source),join(directory,destination))
  if(state.loseAcknowledgement){state.loseAcknowledgement=false;throw new Error('helper acknowledgement lost')}
 },
}))
import {retainNativeWriteback,recoverNativeWritebackOutbox} from './outbox.js'
import type {NativeWritebackBundle} from './capture.js'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});state.loseAcknowledgement=false})
async function fixture(){state.root=await realpath(await mkdtemp(join(tmpdir(),'writeback-outbox-')));roots.push(state.root)}
const bundle=(owner='owner'):NativeWritebackBundle=>({id:randomUUID(),engineAgentId:owner,sessionId:'session',runId:'run',files:[],unsupported:[]})
it('recovers the same single-link capture after a lost atomic publication acknowledgement',async()=>{
 await fixture();const capture=bundle();state.loseAcknowledgement=true
 await expect(retainNativeWriteback(capture)).rejects.toThrow('unconfirmed')
 const path=join(state.root,'desktop-native-writeback-outbox',capture.id+'.json')
 expect((await lstat(path)).nlink).toBe(1)
 expect(JSON.parse(await readFile(path,'utf8'))).toEqual(capture)
 const sent=vi.fn(async()=>{})
 expect(await recoverNativeWritebackOutbox(sent)).toEqual({recovered:[capture.id],retained:[]})
 expect(sent).toHaveBeenCalledWith(capture)
 await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'})
})
it('retains a refused owner without blocking another owner or startup recovery',async()=>{
 await fixture();const refused=bundle('deleted'),accepted=bundle('current')
 await retainNativeWriteback(refused);await retainNativeWriteback(accepted)
 const result=await recoverNativeWritebackOutbox(async value=>{if(value.engineAgentId==='deleted')throw new Error('owner unavailable')})
 expect(result).toEqual({recovered:[accepted.id],retained:[refused.id]})
 expect(JSON.parse(await readFile(join(state.root,'desktop-native-writeback-outbox',refused.id+'.json'),'utf8'))).toEqual(refused)
})
