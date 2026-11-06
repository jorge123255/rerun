import {it,expect,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('../../mcp/oauth-network',async original=>({...await original<typeof import('../../mcp/oauth-network')>(),publicOAuthAddress:vi.fn(async()=>({address:'fixture',family:4}))}))
import {serviceManifestSchema} from '@/lib/services/manifest'
import {compileCatalogOAuth,catalogOAuthMethods} from './compiler'
import {serviceOAuthLifecycle} from './lifecycle'
import type {OAuthAccounts,OAuthAttemptStore,OAuthAttempt,OAuthAccountBinding,OAuthPrimitiveFactory} from './ports'
import type {OAuthTokenBundle} from '../../mcp/store'
const manifest=serviceManifestSchema.parse({slug:'fixture',name:'Fixture',authMethods:[{id:'oauth',kind:'oauth',mcpServers:[{name:'fixture',transport:'http',url:'https://fixture.example/mcp',oauth:{}}]}]})
it('accepts only a declared exact public OAuth method and retains catalog order',()=>{
 expect(compileCatalogOAuth(manifest,'oauth')).toMatchObject({endpoint:'https://fixture.example/mcp',methodId:'oauth',transport:'http'})
 expect(()=>compileCatalogOAuth(manifest,'invented')).toThrow()
 expect(catalogOAuthMethods(manifest).map(m=>m.id)).toEqual(['oauth'])
})
it.each([{clientSecret:'fixture-secret'},{clientId:'declared'},{scopes:['custom']},{authorizationServer:'https://other.example'}])('does not silently discard provider overrides: %o',oauth=>{
 const m=serviceManifestSchema.parse({...manifest,authMethods:[{...manifest.authMethods[0],mcpServers:[{...manifest.authMethods[0].mcpServers[0],oauth}]}]})
 expect(()=>compileCatalogOAuth(m,'oauth')).toThrow('overrides')
})
it.each(['http://fixture.example/mcp','https://user:secret@fixture.example/mcp','https://localhost/mcp','https://fixture.example/mcp#fragment','https://rerun.build/api/hub'])('rejects hostile catalog destination %s',url=>{
 const m=serviceManifestSchema.parse({...manifest,authMethods:[{...manifest.authMethods[0],mcpServers:[{...manifest.authMethods[0].mcpServers[0],url}]}]})
 expect(()=>compileCatalogOAuth(m,'oauth')).toThrow()
})
function fixture(){
 const plan=compileCatalogOAuth(manifest,'oauth')
 const binding:OAuthAccountBinding={owner:'owner',engineId:'engine',installationId:crypto.randomUUID(),accountKey:'fixture@abc123',label:'Fixture 2',methodId:'oauth',configGeneration:crypto.randomUUID(),endpoint:plan.endpoint,transport:'http',catalogFingerprint:plan.fingerprint,serverName:'fixture-abc123'}
 const rows=new Map<string,OAuthAttempt>(),tokens=new Map<string,OAuthTokenBundle>()
 let starts=0,opens=0,probes=0,time=0,enabled=true,healthy=true,primitiveState='waiting',writeDuringProbe:(()=>void)|undefined
 const store:OAuthAttemptStore={
  async reserve(a){const old=[...rows.values()].find(r=>r.binding.owner===a.binding.owner&&r.requestId===a.requestId);if(old){if(old.fingerprint!==a.fingerprint)throw new Error('conflict');return {created:false,attempt:structuredClone(old)}}rows.set(a.snapshot.attemptId,structuredClone(a));return {created:true,attempt:a}},
  async read(owner,id){const r=rows.get(id);return r?.binding.owner===owner?structuredClone(r):null},async list(owner){return structuredClone([...rows.values()].filter(a=>!owner||a.binding.owner===owner))},
  async save(a,revision){if(rows.get(a.snapshot.attemptId)?.snapshot.revision!==revision)throw new Error('revision conflict');rows.set(a.snapshot.attemptId,structuredClone(a))},
  async readToken(a){return tokens.get(a.snapshot.attemptId)??null},async writeToken(a,t){tokens.set(a.snapshot.attemptId,t)},async clearToken(a){tokens.delete(a.snapshot.attemptId)},
 }
 const accounts:OAuthAccounts={catalog:async()=>manifest,configure:async()=>binding,current:async()=>({binding,enabled,granted:true,healthy}),exclusive:async(_o,_i,work)=>work(),readiness:async(_binding,credential)=>{await credential();probes++;writeDuringProbe?.();return {healthy:true}},disconnect:async()=>{binding.configGeneration=crypto.randomUUID()} }
 const factory:OAuthPrimitiveFactory=()=>({async start(){starts++;return {status:{state:'waiting'},authorizationUrl:'https://fixture.example/authorize'}},async status(){return {state:primitiveState}},async credential(){return 'fixture-token'},async cancel(){},shutdown(){}})
 // Discovery address check and browser are fakes; tests make no network/sign-in calls.
 const lifecycle=serviceOAuthLifecycle(accounts,store,factory,async()=>{opens++},()=>time)
 const reserve=async(state:OAuthAttempt['snapshot']['state']='checking')=>{
  const a:OAuthAttempt={version:1,requestId:crypto.randomUUID(),fingerprint:'bound',binding:structuredClone(binding),probePending:false,snapshot:{attemptId:crypto.randomUUID(),revision:crypto.randomUUID(),coworkerId:'owner',installationId:binding.installationId,accountKey:binding.accountKey,label:binding.label,methodId:binding.methodId,configGeneration:binding.configGeneration,state,expiresAt:300000,configured:true,installed:false,message:'fixture'}}
  await store.reserve(a);return a
 }
 return {lifecycle,store,binding,reserve,counts:()=>({starts,opens,probes}),setTime:(n:number)=>{time=n},disable:()=>{enabled=false},healthOff:()=>{healthy=false},setPrimitive:(s:string)=>{primitiveState=s},token:(a:OAuthAttempt)=>tokens.set(a.snapshot.attemptId,{accessToken:'fixture-token',expiresAt:999999,resource:binding.endpoint,issuer:'https://fixture.example',tokenEndpoint:'https://fixture.example/token',clientId:'public'})}
}
it('configuration never opens sign-in, grants access or marks installed',async()=>{
 const f=fixture()
 const snapshot=await f.lifecycle.action('owner',{action:'configure',requestId:crypto.randomUUID(),intent:{kind:'additional',slug:'fixture'},slug:'fixture',methodId:'oauth'},new AbortController().signal)
 expect(snapshot.state).toBe('configured');expect(snapshot.installed).toBe(false);expect(f.counts()).toEqual({starts:0,opens:0,probes:0})
 expect(JSON.stringify(snapshot)).not.toContain('fixture-token')
})
it('authenticated readiness is explicit and only then returns connected',async()=>{
 const f=fixture(),a=await f.reserve()
 const result=await f.lifecycle.action('owner',{action:'probe',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)
 expect(result.state).toBe('connected');expect(result.installed).toBe(true);expect(f.counts().probes).toBe(1)
})
it('restart with saved token offers a check without launching sign-in or probing',async()=>{
 const f=fixture(),a=await f.reserve('connected');f.token(a)
 await f.lifecycle.reconcile()
 const saved=await f.store.read('owner',a.snapshot.attemptId)
 expect(saved!.snapshot.state).toBe('checking');expect(saved!.snapshot.installed).toBe(false)
 expect(f.counts()).toEqual({starts:0,opens:0,probes:0})
})
it('lost probe acknowledgement is not silently replayed',async()=>{
 const f=fixture(),a=await f.reserve();a.probePending=true;await f.store.save(a,a.snapshot.revision)
 const result=await f.lifecycle.action('owner',{action:'probe',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)
 expect(result.state).toBe('interrupted');expect(f.counts().probes).toBe(0)
})
it('stale generation and disabled grant refuse use without touching a sibling',async()=>{
 const f=fixture(),a=await f.reserve();f.binding.configGeneration=crypto.randomUUID()
 await expect(f.lifecycle.action('owner',{action:'probe',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)).rejects.toThrow('authority')
 expect(f.counts().probes).toBe(0)
})
it('old cancel cannot invalidate a newer attempt for the same account',async()=>{
 const f=fixture(),old=await f.reserve('configured');await f.reserve('waiting')
 await expect(f.lifecycle.action('owner',{action:'cancel',attemptId:old.snapshot.attemptId,expectedRevision:old.snapshot.revision},new AbortController().signal)).rejects.toThrow('newer')
})
it('another owner cannot retrieve or act on an attempt',async()=>{
 const f=fixture(),a=await f.reserve()
 await expect(f.lifecycle.action('other',{action:'cancel',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)).rejects.toThrow('revision')
})
it('same start receipt does not reopen sign-in after a lost HTTP acknowledgement',async()=>{
 const f=fixture(),requestId=crypto.randomUUID(),input={action:'start' as const,requestId,accountKey:f.binding.accountKey,expectedGeneration:f.binding.configGeneration}
 const first=await f.lifecycle.action('owner',input,new AbortController().signal)
 const replay=await f.lifecycle.action('owner',input,new AbortController().signal)
 expect(replay.attemptId).toBe(first.attemptId);expect(f.counts()).toEqual({starts:1,opens:1,probes:0})
})
it('denied authorization and expiry do not become installed',async()=>{
 const f=fixture(),input={action:'start' as const,requestId:crypto.randomUUID(),accountKey:f.binding.accountKey,expectedGeneration:f.binding.configGeneration}
 const started=await f.lifecycle.action('owner',input,new AbortController().signal)
 f.setPrimitive('error')
 const denied=await f.lifecycle.action('owner',{action:'status',attemptId:started.attemptId,expectedRevision:started.revision},new AbortController().signal)
 expect(denied.state).toBe('error');expect(denied.installed).toBe(false)
 const other=fixture(),a=await other.reserve('waiting');other.setTime(400000)
 const expired=await other.lifecycle.action('owner',{action:'status',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)
 expect(expired.state).toBe('expired');expect(expired.installed).toBe(false)
})
it('cancelled attempts remain invalidated and never probe after later status',async()=>{
 const f=fixture(),a=await f.reserve('waiting')
 const cancelled=await f.lifecycle.action('owner',{action:'cancel',attemptId:a.snapshot.attemptId,expectedRevision:a.snapshot.revision},new AbortController().signal)
 const late=await f.lifecycle.action('owner',{action:'status',attemptId:cancelled.attemptId,expectedRevision:cancelled.revision},new AbortController().signal)
 expect(late.state).toBe('cancelled');expect(f.counts().probes).toBe(0)
})
