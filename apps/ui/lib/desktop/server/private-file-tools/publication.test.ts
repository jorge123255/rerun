import {createClient} from '@libsql/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const files=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),create:vi.fn()}))
vi.mock('../coworker-files',()=>({readCoworkerFile:files.read,saveCoworkerFile:files.save,importCoworkerFile:files.create}))
import {privateFilePublisher,privateFileReceiptSchema,type PrivateFileCall} from './publication'
import type {DesktopRuntime} from '../runtime'
const clients:ReturnType<typeof createClient>[]=[]
const runtime={dataRoot:'/example/private'} as DesktopRuntime
const call:PrivateFileCall={engineAgentId:'engine',sessionId:'session',runId:'run',toolCallId:'call',tool:'fs_edit',arguments:{path:'note.md',oldString:'old',newString:'new'}}
beforeEach(()=>{vi.resetAllMocks();files.read.mockResolvedValue({content:'old',hash:'hash',identity:'1:2',truncated:false});files.save.mockResolvedValue({path:'note.md'})})
afterEach(()=>{for(const db of clients.splice(0))db.close()})
async function setup(){const db=createClient({url:'file::memory:'});clients.push(db);await db.executeMultiple(privateFileReceiptSchema);let enabled=true;const authorize=vi.fn(async()=>{if(!enabled)throw new Error('revoked');return {owner:'owner',runtime}});return {db,authorize,revoke:()=>{enabled=false},publish:privateFilePublisher(db,authorize)}}
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
 expect((await publish(call,new AbortController().signal)).status).toBe('unknown')
 expect(files.create).not.toHaveBeenCalled()
})
it('creates through no-replace import with existing-directory-only authority hooks',async()=>{
 const {publish}=await setup()
 const create:PrivateFileCall={...call,tool:'fs_write',arguments:{path:'notes/new.md',content:'complete'}}
 files.create.mockImplementation(async(...args:unknown[])=>{expect(args.slice(2,4)).toEqual(['notes','new.md']);const hook=args[5] as {existingDirectoryOnly:boolean;beforePublish:()=>Promise<void>};expect(hook.existingDirectoryOnly).toBe(true);await hook.beforePublish();return {path:'notes/new.md'}})
 expect((await publish(create,new AbortController().signal)).status).toBe('saved')
 expect(files.save).not.toHaveBeenCalled()
})
