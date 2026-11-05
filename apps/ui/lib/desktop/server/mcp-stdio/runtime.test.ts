import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('node:fs/promises',()=>({realpath:async(path:string)=>path}))
const state=vi.hoisted(()=>({spawn:vi.fn(),calls:0,failCall:false,failDrain:false,drains:0}))
vi.mock('./process',()=>({executableIdentity:async()=> 'executable-version',spawnStdio:(_config:unknown,_cwd:string,signal:AbortSignal)=>{
 state.spawn();let closed=false;signal.addEventListener('abort',()=>{closed=true},{once:true})
 return {closed:()=>closed,close:()=>{closed=true},drain:async()=>{state.drains++;if(state.failDrain)throw new Error('exit unconfirmed');closed=true},rpc:async(method:string)=>{
  if(method==='initialize')return {protocolVersion:'2025-03-26'}
  if(method==='tools/list')return {tools:[{name:'hello',inputSchema:{type:'object'}}]}
  if(method==='tools/call'){state.calls++;if(state.failCall)throw new Error('acknowledgement lost');return {content:[{type:'text',text:'fixture'}],isError:false}}
  return {}
 }}
}}))
import {stdioSchema,stdioStore} from './store'
import {stdioRuntime,type StdioRun} from './runtime'
const resources:{db:ReturnType<typeof createClient>;runtime:ReturnType<typeof stdioRuntime>}[]=[]
afterEach(async()=>{state.failDrain=false;for(const {db,runtime} of resources.splice(0)){await runtime.shutdown();db.close()}state.calls=0;state.failCall=false;state.drains=0;state.spawn.mockClear()})
const run:StdioRun={engineAgentId:'engine',sessionId:'session',runId:'run'}
async function setup(){
 const db=createClient({url:'file::memory:'});await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+stdioSchema)
 const store=stdioStore(db);let granted=true
 const runtime=stdioRuntime(store,async(owner,action)=>{if(owner!=='owner' || action==='use'&&!granted)throw new Error('grant off');return {cwd:'/example/private'}})
 resources.push({db,runtime});await store.save('owner',{name:'local',executable:'/example/fixture',args:[]})
 const revision=(await store.list('owner'))[0].revision
 return {db,store,runtime,revision,revoke:()=>{granted=false}}
}
it('reserves one opening for simultaneous probes and preserves owner-scoped config',async()=>{
 const {runtime,store,revision}=await setup(),signal=new AbortController().signal
 await Promise.all([runtime.probe('owner','local',revision,signal),runtime.probe('owner','local',revision,signal)])
 expect(state.spawn).toHaveBeenCalledTimes(1)
 expect(await store.list('other')).toEqual([])
})
it('does not admit a subprocess with a revoked separate grant',async()=>{
 const {runtime,revision,revoke}=await setup();revoke()
 await expect(runtime.probe('owner','local',revision,new AbortController().signal)).rejects.toThrow()
 expect(state.spawn).not.toHaveBeenCalled()
})
it('never replays an already submitted tool call after reconnect, including unknown acknowledgement',async()=>{
 const {runtime}=await setup(),signal=new AbortController().signal
 const first=(await runtime.tools('owner',run,signal))[0];state.failCall=true
 await expect(first.execute({},'exact-call',signal)).rejects.toThrow('lost')
 await runtime.disconnect('owner','local')
 const second=(await runtime.tools('owner',run,signal))[0]
 await expect(second.execute({},'exact-call',signal)).rejects.toThrow('already submitted')
 expect(state.calls).toBe(1)
})
it('invalidates captured tools across a persisted owner transition and permanent shutdown',async()=>{
 const {runtime}=await setup(),signal=new AbortController().signal,tool=(await runtime.tools('owner',run,signal))[0]
 await runtime.transitionOwner('owner',async()=>{})
 await expect(tool.execute({},'later',signal)).rejects.toThrow()
 await runtime.shutdown()
 await expect(runtime.tools('owner',run,signal)).rejects.toThrow()
 expect(state.calls).toBe(0)
})
it('retains failed process drains across shutdown and blocks replacement admission',async()=>{
 const {runtime,revision}=await setup(),signal=new AbortController().signal
 await runtime.probe('owner','local',revision,signal)
 state.failDrain=true
 await expect(runtime.disconnect('owner','local')).rejects.toThrow('unconfirmed')
 // Cancellation may win the observer race; neither outcome can admit a second process.
 await expect(runtime.probe('owner','local',revision,signal)).rejects.toThrow()
 expect(state.spawn).toHaveBeenCalledTimes(1)
 await expect(runtime.shutdown()).rejects.toThrow('unconfirmed')
 expect(state.drains).toBeGreaterThan(1)
})
it('closes an idle connection on exact run release while retaining another live run',async()=>{
 const {runtime}=await setup(),signal=new AbortController().signal
 const first=await runtime.tools('owner',run,signal)
 const other={...run,runId:'other-run'}
 await runtime.tools('owner',other,signal)
 await runtime.releaseRun('owner',run)
 expect(state.drains).toBe(0)
 await runtime.releaseRun('owner',other)
 expect(state.drains).toBeGreaterThan(0)
 await expect(first[0].execute({},'after-release',signal)).rejects.toThrow()
})
