import {EventEmitter} from 'node:events'
import {PassThrough,Writable} from 'node:stream'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {spawnStdio,stdioEnvironment,type StdioSpawn} from './process'
afterEach(()=>vi.restoreAllMocks())
function fake(){
 const child=new EventEmitter() as EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;stdin:Writable;kill:ReturnType<typeof vi.fn>;exitCode:null;signalCode:null}
 child.pid=424242;child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn()
 child.stdin=new Writable({write(chunk,_encoding,done){const request=JSON.parse(String(chunk));if(request.id)queueMicrotask(()=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{ok:true}})+'\n'));done()}})
 const spawn=vi.fn(()=>child) as unknown as StdioSpawn
 return {child,spawn}
}
it('starts the literal executable/argument array with shell false and only allowlisted env',async()=>{
 vi.spyOn(process,'kill').mockImplementation(()=>true)
 const {child,spawn}=fake(),stop=new AbortController()
 const runner=spawnStdio({name:'fixture',revision:'r',transport:'stdio',executable:'/example/installed-fixture',args:['literal argument','$(not a shell)']},'/example/private',stop.signal,spawn)
 expect(spawn).toHaveBeenCalledWith('/example/installed-fixture',['literal argument','$(not a shell)'],expect.objectContaining({shell:false,detached:true,env:{...stdioEnvironment}}))
 expect(await runner.rpc('initialize',{},stop.signal)).toEqual({ok:true})
 stop.abort();expect(runner.closed()).toBe(true)
 expect(process.kill).toHaveBeenCalledWith(-child.pid,'SIGTERM')
 child.emit('exit');await runner.drain()
})
it('refuses oversized output and never exposes stderr',async()=>{
 vi.spyOn(process,'kill').mockImplementation(()=>true)
 const {child,spawn}=fake(),stop=new AbortController(),runner=spawnStdio({name:'fixture',revision:'r',transport:'stdio',executable:'/example/installed-fixture',args:[]},'/example/private',stop.signal,spawn)
 child.stderr.write(Buffer.alloc(65537,65));expect(runner.closed()).toBe(true)
 await expect(runner.rpc('tools/call',{},stop.signal)).rejects.toThrow('disconnected')
 child.emit('exit');await runner.drain()
})
