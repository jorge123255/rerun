import {createClient,type InStatement} from '@libsql/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const files=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),create:vi.fn()}))
vi.mock('../coworker-files',()=>({readPrivateCoworkerFile:files.read,saveCoworkerFile:files.save,importCoworkerFile:files.create}))
import {privateFilePublisher,privateFileReceiptSchema,type PrivateFileCall} from './publication'
import type {DesktopRuntime} from '../runtime'
const clients:ReturnType<typeof createClient>[]=[]
const runtime={dataRoot:'/example/private'} as DesktopRuntime
const call:PrivateFileCall={engineAgentId:'engine',sessionId:'session',runId:'run',toolCallId:'call',tool:'fs_edit',arguments:{path:'note.md',oldString:'old',newString:'new'}}
beforeEach(()=>{vi.resetAllMocks();files.read.mockResolvedValue({content:'old',hash:'hash',identity:'1:2',truncated:false});files.save.mockResolvedValue({path:'note.md'})})
afterEach(()=>{for(const db of clients.splice(0))db.close()})
async function setup(){const db=createClient({url:'file::memory:'});clients.push(db);await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');"+privateFileReceiptSchema);let enabled=true;const authorize=vi.fn(async()=>{if(!enabled)throw new Error('revoked');return {owner:'owner',runtime}});return {db,authorize,revoke:()=>{enabled=false},publish:privateFilePublisher(db,authorize)}}
it('replays the durable exact call after a lost response/new service without publishing twice',async()=>{
 const {db,authorize,publish}=await setup()
 const first=await publish(call,new AbortController().signal)
 expect(first.status).toBe('saved')
 expect(await privateFilePublisher(db,authorize)(call,new AbortController().signal)).toEqual(first)
 expect(files.save).toHaveBeenCalledTimes(1)
 expect(files.save.mock.calls[0].slice(4,6)).toEqual(['hash','1:2'])
 await expect(publish({...call,arguments:{...call.arguments,newString:'different'}},new AbortController().signal)).rejects.toThrow('reused')
})
it('refuses truncated reads and never republishes a claimed unknown call',async()=>{
 const {db,publish}=await setup()
 files.read.mockResolvedValueOnce({content:'old',truncated:true})
 await expect(publish(call,new AbortController().signal)).rejects.toThrow('Complete')
 files.save.mockRejectedValueOnce(new Error('ack lost'))
 expect((await publish(call,new AbortController().signal)).status).toBe('unknown')
 expect((await publish(call,new AbortController().signal)).status).toBe('unknown')
 expect(files.save).toHaveBeenCalledTimes(1)
 expect((await db.execute('SELECT state FROM desktop_private_file_calls')).rows[0].state).toBe('claimed')
})
it('passes fresh publication authority into existing save/import mechanisms',async()=>{
 const {publish,revoke}=await setup()
 files.save.mockImplementation(async(...args:unknown[])=>{revoke();await (args[6] as {beforePublish:()=>Promise<void>}).beforePublish()})
 await expect(publish(call,new AbortController().signal)).rejects.toThrow('revoked')
 expect(files.create).not.toHaveBeenCalled()
})
it('creates through no-replace import with existing-directory-only authority hooks',async()=>{
 const {publish}=await setup()
 const create:PrivateFileCall={...call,tool:'fs_write',arguments:{path:'notes/new.md',content:'complete'}}
 files.create.mockImplementation(async(...args:unknown[])=>{expect(args.slice(2,4)).toEqual(['notes','new.md']);const hook=args[5] as {existingDirectoryOnly:boolean;beforePublish:()=>Promise<void>};expect(hook.existingDirectoryOnly).toBe(true);await hook.beforePublish();return {path:'notes/new.md'}})
 expect((await publish(create,new AbortController().signal)).status).toBe('saved')
 expect(files.save).not.toHaveBeenCalled()
})

it('durably records unchanged calls and refuses different arguments after a service restart',async()=>{
 const {db,authorize,publish}=await setup()
 const unchanged:PrivateFileCall={...call,arguments:{path:'note.md',oldString:'old',newString:'old'}}
 const first=await publish(unchanged,new AbortController().signal)
 expect(first.status).toBe('unchanged')
 expect((await db.execute('SELECT state FROM desktop_private_file_calls')).rows[0].state).toBe('unchanged')
 files.read.mockRejectedValue(new Error('document changed after first invocation'))
 const restarted=privateFilePublisher(db,authorize)
 expect(await restarted(unchanged,new AbortController().signal)).toEqual(first)
 await expect(restarted(call,new AbortController().signal)).rejects.toThrow('reused')
 expect(files.save).not.toHaveBeenCalled()
})

it('Stop settles the first observer while a read is stalled and retains its in-flight identity',async()=>{
 const {publish}=await setup()
 let release!:()=>void, entered!:()=>void
 const began=new Promise<void>(resolve=>{entered=resolve})
 files.read.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve});return {content:'old',hash:'hash',identity:'1:2',truncated:false}})
 const stop=new AbortController()
 const first=publish(call,stop.signal)
 await began
 stop.abort()
 expect((await first).status).toBe('unknown')
 await expect(publish({...call,arguments:{path:'note.md',oldString:'old',newString:'different'}},new AbortController().signal)).rejects.toThrow('reused')
 release()
 await vi.waitFor(()=>expect(files.save).not.toHaveBeenCalled())
})

it('a timed-out acknowledgement keeps its receipt and never republishes after late completion',async()=>{
 const {db,authorize}=await setup()
 let release!:()=>void, entered!:()=>void
 const began=new Promise<void>(resolve=>{entered=resolve})
 const execute=db.execute.bind(db)
 vi.spyOn(db,'execute').mockImplementation(async(statement,...rest)=>{
  const input=statement as InStatement
  const sql=typeof input==='string'?input:input.sql
  if(sql.startsWith('UPDATE desktop_private_file_calls')){entered();await new Promise<void>(resolve=>{release=resolve})}
  return execute(statement,...rest)
 })
 const publish=privateFilePublisher(db,authorize)
 const stop=new AbortController(), first=publish(call,stop.signal)
 await began
 stop.abort()
 expect((await first).status).toBe('unknown')
 expect(files.save).toHaveBeenCalledTimes(1)
 expect((await privateFilePublisher(db,authorize)(call,new AbortController().signal)).status).toBe('unknown')
 release()
 await vi.waitFor(async()=>expect((await db.execute('SELECT state FROM desktop_private_file_calls')).rows[0].state).toBe('saved'))
 expect((await privateFilePublisher(db,authorize)(call,new AbortController().signal)).status).toBe('saved')
 expect(files.save).toHaveBeenCalledTimes(1)
})

it('Stop during an uncertain claim keeps a late accepted claim without publishing afterwards',async()=>{
 const {db,authorize}=await setup()
 let release!:()=>void, entered!:()=>void
 const began=new Promise<void>(resolve=>{entered=resolve})
 const execute=db.execute.bind(db)
 vi.spyOn(db,'execute').mockImplementation(async(statement,...rest)=>{
  const input=statement as InStatement
  const sql=typeof input==='string'?input:input.sql
  if(sql.startsWith('INSERT INTO desktop_private_file_calls')){entered();await new Promise<void>(resolve=>{release=resolve})}
  return execute(statement,...rest)
 })
 const publish=privateFilePublisher(db,authorize), stop=new AbortController()
 const first=publish(call,stop.signal)
 await began
 stop.abort()
 expect((await first).status).toBe('unknown')
 release()
 await vi.waitFor(async()=>expect((await db.execute('SELECT state FROM desktop_private_file_calls')).rows[0]?.state).toBe('claimed'))
 expect((await privateFilePublisher(db,authorize)(call,new AbortController().signal)).status).toBe('unknown')
 expect(files.save).not.toHaveBeenCalled()
})
