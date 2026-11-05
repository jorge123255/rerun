import {afterEach,expect,it,vi} from 'vitest'
import {createDesktopServicesClient} from './services-client'
afterEach(()=>vi.unstubAllGlobals())
function detail(kind='key',supported=true){return {key:'fixture',slug:'fixture',name:'Fixture',category:'dev',summary:'',description:'',icon:null,installed:false,installStatus:null,multiInstance:false,instances:[],installation:null,localLimitations:'Local only',authMethods:[{id:'exact',label:'Method',kind,recommended:true,requiresSecrets:kind==='key',inputs:kind==='key'?[{key:'TOKEN',label:'Token',type:'password',secret:true,required:true}]:[]}],methodAvailability:[{id:'exact',supported,reason:supported?undefined:'Unavailable locally'}]}}
it('rejects unknown IDs, cloud auth and another owner before install submission',async()=>{
 const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>Response.json(detail('oauth',false)));vi.stubGlobal('fetch',fetcher)
 const client=createDesktopServicesClient('a')
 expect((await client.driver.install('b','fixture',{},'exact')).ok).toBe(false)
 expect((await client.driver.install('a','fixture',{},'unknown')).ok).toBe(false)
 expect((await client.driver.install('a','fixture',{},'exact')).ok).toBe(false)
 expect(fetcher.mock.calls.every(call=>(call[1] as RequestInit|undefined)?.method!=='POST')).toBe(true)
 client.dispose()
})
it('retains the exact request UUID across unknown acknowledgement without replaying a cloud flow',async()=>{
 const sent:Record<string,unknown>[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
  if(init.method==='GET')return Response.json(detail())
  sent.push(JSON.parse(String(init.body)));throw new Error('response lost')
 }))
 const client=createDesktopServicesClient('a')
 await client.driver.install('a','fixture',{TOKEN:'fixture-only'},'exact')
 await client.driver.install('a','fixture',{TOKEN:'fixture-only'},'exact')
 expect(sent).toHaveLength(2);expect(sent[0].requestId).toBe(sent[1].requestId)
 expect(sent[0].authMethodId).toBe('exact')
 client.dispose()
})
it('withholds a late old-owner result after disposal',async()=>{
 let finish!:(value:Response)=>void
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})))
 const client=createDesktopServicesClient('a'),pending=client.details('fixture')
 const refusal=expect(pending).rejects.toThrow();client.dispose();finish(Response.json(detail()))
 await refusal
})
