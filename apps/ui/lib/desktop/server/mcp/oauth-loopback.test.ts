import {createClient} from '@libsql/client'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
type HttpHandler=(req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>void
const http=vi.hoisted(()=>({callback:null as null|HttpHandler,closed:vi.fn()}))
vi.mock('node:http',()=>({createServer:(callback:HttpHandler)=>{http.callback=callback;return {once:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),address:()=>({port:49152}),close:http.closed,closeIdleConnections:()=>{}}}}))
vi.mock('./oauth-network',async original=>({...await original<typeof import('./oauth-network')>(),publicOAuthAddress:vi.fn(async()=>({address:'93.184.216.34',family:4}))}))
import {migrateDesktopSse} from '../mcp-sse/schema'
import {bindRemoteTransportDrain,remoteMcpStore,remoteMcpSchema,remoteMcpOAuthSchema} from './store'
import {loopbackMcpOAuth} from './oauth-loopback'
import {discoverLoopbackOAuth,type OAuthJson} from './oauth-network'
import {createMcpOAuthAttempts,remoteMcpOAuthAttemptSchema} from './oauth-attempt'
import {credentialGenerationToken} from './credential-generation'
import {bindApprovedMcpDeviceCustody} from '../mcp-device-custody/binding'
import {desktopMcpDeviceCustodySchema} from '../mcp-device-custody/store'
import type {DeviceApproval} from '../mcp-device-custody/model'
const clients:ReturnType<typeof createClient>[]=[]
const roots:string[]=[]
const services:ReturnType<typeof loopbackMcpOAuth>[]=[]
afterEach(async()=>{for(const service of services.splice(0))service.shutdown();vi.restoreAllMocks();for(const db of clients.splice(0))db.close();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));vi.useRealTimers();vi.clearAllMocks()})
const resource='https://mcp.example/mcp',issuer='https://auth.example/'
function fixture(){
 let exchanges=0,refreshes=0
 const json:OAuthJson=vi.fn(async(url,_signal,body)=>{
  if(url.includes('oauth-protected-resource'))return {resource,authorization_servers:[issuer],scopes_supported:['read']}
  if(url.includes('oauth-authorization-server'))return {issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'token',registration_endpoint:issuer+'register',token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],response_types_supported:['code'],authorization_response_iss_parameter_supported:true}
  if(url.endsWith('register'))return {client_id:'public-client',token_endpoint_auth_method:'none',redirect_uris:(body as Record<string,unknown>).redirect_uris}
  if(body instanceof URLSearchParams && body.get('grant_type')==='authorization_code'){exchanges++;expect(body.get('resource')).toBe(resource);expect(body.get('code_verifier')).toHaveLength(43)}
  else refreshes++
  return {access_token:'access',refresh_token:'rotating',expires_in:3600,token_type:'Bearer'}
 })
 return {json,exchanges:()=>exchanges,refreshes:()=>refreshes}
}
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'rerun-browser-oauth-'));roots.push(root)
 const db=createClient({url:`file:${join(root,'app.db')}`});clients.push(db)
 await db.executeMultiple('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES (\'a\');'+remoteMcpSchema+remoteMcpOAuthSchema+remoteMcpOAuthAttemptSchema+desktopMcpDeviceCustodySchema)
 await migrateDesktopSse(db)
 const key=()=>Buffer.alloc(32,7),store=remoteMcpStore(db,key);await store.save('a',{name:'x',url:resource})
 const revision=(await store.list('a'))[0].revision,fixture_=fixture()
 let granted=true
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted}),fixture_.json,store,createMcpOAuthAttempts(db));services.push(oauth)
 return {db,key,store,revision,oauth,...fixture_,revoke:()=>{granted=false}}
}
function callback(state:string,iss=issuer){
 const res={writeHead:vi.fn(),end:vi.fn()}
 http.callback!({method:'GET',headers:{host:'127.0.0.1:49152'},url:'/callback?'+new URLSearchParams({state,code:'example-code',iss}),socket:{remoteAddress:'127.0.0.1',setTimeout:()=>{},destroy:()=>{}}} as unknown as import('node:http').IncomingMessage,res as unknown as import('node:http').ServerResponse)
 return res
}
async function flush(){for(let i=0;i<80;i++)await Promise.resolve()}
it('uses exact resource/issuer metadata and refuses secret/CIMD-only providers',async()=>{
 const {json}=fixture()
 expect((await discoverLoopbackOAuth(resource,new AbortController().signal,json)).resource).toBe(resource)
 await expect(discoverLoopbackOAuth('https://other.example/mcp',new AbortController().signal,json)).rejects.toThrow('exact resource')
 const noRegistration:OAuthJson=async(url,signal,body)=>{const value=await json(url,signal,body);if(url.includes('oauth-authorization-server'))delete value.registration_endpoint;return value}
 await expect(discoverLoopbackOAuth(resource,new AbortController().signal,noRegistration)).rejects.toThrow('endpoint identity')
})
it('rejects wrong state, consumes a valid callback once, and encrypts tokens outside config',async()=>{
 const {oauth,revision,exchanges,store,db}=await setup()
 const started=await oauth.start('a','x',revision,new AbortController().signal)
 const url=new URL(started.authorizationUrl!),state=url.searchParams.get('state')!
 expect(url.searchParams.get('code_challenge_method')).toBe('S256')
 callback('wrong');expect(exchanges()).toBe(0)
 callback(state);await vi.waitFor(async()=>expect((await oauth.status('a','x',revision,new AbortController().signal)).state).toBe('connected'));callback(state);await flush()
 expect(exchanges()).toBe(1)
 expect((await oauth.status('a','x',revision,new AbortController().signal)).state).toBe('connected')
 expect((await store.read('a','x')).bearer).toBe('')
 expect(String((await db.execute('SELECT bundle FROM desktop_remote_mcp_oauth')).rows[0].bundle)).not.toContain('rotating')
 expect(await oauth.credential('a','x',revision,new AbortController().signal)).toBe('access')
})
for (const duringExchange of [false, true]) it(`preserves a newer credential when it is saved ${duringExchange ? 'during' : 'before'} the browser exchange`, async () => {
 const {store, revision, db, json, exchanges}=await setup()
 let notifyExchange!: () => void
 let resumeExchange!: () => void
 const entered=new Promise<void>(resolve=>{notifyExchange=resolve})
 const resumed=new Promise<void>(resolve=>{resumeExchange=resolve})
 const delayed:OAuthJson=async(url,signal,body)=>{
  if(body instanceof URLSearchParams && body.get('grant_type')==='authorization_code'){
   notifyExchange()
   if(duringExchange)await resumed
  }
  return json(url,signal,body)
 }
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),delayed,store)
 services.push(oauth)
 const signal=new AbortController().signal
 const started=await oauth.start('a','x',revision,signal)
 const state=new URL(started.authorizationUrl!).searchParams.get('state')!
 const inFlight=duringExchange ? callback(state) : undefined
 if(duringExchange)await entered
 try {
  // A separate store shares durable state without sharing process-local lifecycle tickets.
  const writer=remoteMcpStore(db,()=>Buffer.alloc(32,7))
  await writer.writeOAuth('a','x',revision,{accessToken:'newer-approval',expiresAt:Date.now()+3_600_000,resource,issuer,tokenEndpoint:issuer+'token',clientId:'public-client'},signal)
 } finally {
  resumeExchange()
 }
 const response=inFlight ?? callback(state)
 await vi.waitFor(()=>expect(response.writeHead).toHaveBeenCalled())
 expect((await store.readOAuth('a','x'))?.accessToken).toBe('newer-approval')
 expect(response.writeHead).toHaveBeenCalledWith(400,expect.anything())
 expect(exchanges()).toBe(duringExchange ? 1 : 0)
 oauth.shutdown()
 const restored=remoteMcpStore(db,()=>Buffer.alloc(32,7))
 const reopened=loopbackMcpOAuth(restored,async()=>({enabled:true,granted:true}),json,restored)
 services.push(reopened)
 expect(await reopened.status('a','x',revision,signal)).toEqual({state:'connected'})
 expect(await reopened.credential('a','x',revision,signal)).toBe('newer-approval')
})
it('keeps browser authorization available for SSE without admitting device sign-in',async()=>{
 const {db,oauth,revision,store}=await setup()
 await db.execute("UPDATE desktop_remote_mcp SET transport='sse' WHERE agent_id='a' AND name='x'")
 const drain=vi.fn(async()=>{})
 bindRemoteTransportDrain(store,drain)
 const signal=new AbortController().signal
 expect(await store.credentialState('a','x')).toBeNull()
 const started=await oauth.start('a','x',revision,signal)
 const response=callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(()=>expect(response.writeHead).toHaveBeenCalledWith(200,expect.anything()))
 expect(drain).toHaveBeenCalledWith('a','x')
 expect(await oauth.status('a','x',revision,signal)).toEqual({state:'connected'})
})
for(const change of ['disconnect','edit','revoke','quit'] as const)it(`invalidates callback on ${change}`,async()=>{
 const {oauth,revision,store,exchanges,revoke}=await setup()
 const started=await oauth.start('a','x',revision,new AbortController().signal)
 if(change==='disconnect')store.lifecycle.disconnect('a','x')
 if(change==='edit')await store.save('a',{name:'x',url:resource,revision})
 if(change==='revoke')revoke()
 if(change==='quit')oauth.shutdown()
 callback(new URL(started.authorizationUrl!).searchParams.get('state')!);await flush()
 expect(exchanges()).toBe(0)
})
it('serializes rotating refreshes and never falls back to an expired OAuth token',async()=>{
 const {store,revision,oauth,refreshes}=await setup()
 await store.writeOAuth('a','x',revision,{accessToken:'old',refreshToken:'rotating',expiresAt:1,resource,issuer,tokenEndpoint:issuer+'token',clientId:'public-client'},new AbortController().signal)
 expect(await Promise.all([oauth.credential('a','x',revision,new AbortController().signal),oauth.credential('a','x',revision,new AbortController().signal)])).toEqual(['access','access'])
 expect(refreshes()).toBe(1)
})

it('a stale start cannot close or replace a newer authorized attempt',async()=>{
 const {oauth,revision,store}=await setup()
 await store.save('a',{name:'x',url:resource,revision})
 const nextRevision=(await store.list('a'))[0].revision
 const started=await oauth.start('a','x',nextRevision,new AbortController().signal)
 const before=http.closed.mock.calls.length
 await expect(oauth.start('a','x',revision,new AbortController().signal)).rejects.toThrow('authority')
 expect(http.closed).toHaveBeenCalledTimes(before)
 expect(await oauth.status('a','x',nextRevision,new AbortController().signal)).toEqual({state:'waiting'})
 callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(async()=>expect((await oauth.status('a','x',nextRevision,new AbortController().signal)).state).toBe('connected'))
})

it('keeps the original callback when two chats and Settings request the same registration', async () => {
 const {oauth,revision,json,exchanges}=await setup()
 const signal=new AbortController().signal
 const started=await oauth.start('a','x',revision,signal,undefined,'chat-a')
 const requestCount=vi.mocked(json).mock.calls.length
 const closeCount=http.closed.mock.calls.length

 await expect(oauth.start('a','x',revision,signal,undefined,'chat-b')).rejects.toThrow('already in progress')
 await expect(oauth.start('a','x',revision,signal)).rejects.toThrow('already in progress')
 expect(json).toHaveBeenCalledTimes(requestCount)
 expect(http.closed).toHaveBeenCalledTimes(closeCount)
 expect(await oauth.status('a','x',revision,signal,'chat-a')).toEqual({state:'waiting'})
 expect(await oauth.status('a','x',revision,signal,'chat-b')).toEqual({state:'idle'})

 callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(async()=>expect(await oauth.status('a','x',revision,signal,'chat-a')).toEqual({state:'connected'}))
 expect(exchanges()).toBe(1)
})

it('does not let a stale chat cancel a later Settings callback at the same revision', async () => {
 const {oauth,revision,exchanges}=await setup()
 const signal=new AbortController().signal
 await oauth.start('a','x',revision,signal,undefined,'chat-a')
 await oauth.cancel('a','x',revision,signal,'chat-a')

 const started=await oauth.start('a','x',revision,signal)
 const closeCount=http.closed.mock.calls.length
 await oauth.cancel('a','x',revision,signal,'chat-a')
 expect(http.closed).toHaveBeenCalledTimes(closeCount)
 expect(await oauth.status('a','x',revision,signal)).toEqual({state:'waiting'})

 callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(async()=>expect(await oauth.status('a','x',revision,signal)).toEqual({state:'connected'}))
 expect(exchanges()).toBe(1)
})

for (const first of ['browser', 'device'] as const) it(`keeps the ${first} reservation before the other method can reach its provider`, async () => {
 const {db,key,store,revision,oauth,json}=await setup()
 const signal=new AbortController().signal, credential=(await store.credentialState('a','x'))!
 const identity={engineAgentId:'engine-a',sessionId:'chat-a',runId:'run-a'}
 const approval:DeviceApproval={
  workspaceId:'workspace',owner:'a',engineAgentId:identity.engineAgentId,sessionId:identity.sessionId,name:'x',revision,
  approvalId:'approved-device',registrationId:credential.registrationId,approvedUntil:Date.now()+600_000,
  credentialGeneration:credentialGenerationToken(key(),'a','x',credential,credential.sealed),
  method:{kind:'device-code-link-v1',resource,issuer,clientId:'device-client',deviceEndpoint:issuer+'device',tokenEndpoint:issuer+'token',verificationUri:issuer+'activate'},
 }
 const broker={start:vi.fn(async()=>({deviceCode:'fixture-only',verificationUri:issuer+'activate',expiresIn:120,interval:5})),poll:vi.fn()}
 const device=bindApprovedMcpDeviceCustody({db,key,workspaceId:'workspace',watchOwner:()=>()=>{},
  service:{store,authorizeRun:async()=>'a',runtime:{probe:async()=>({tools:[]})},shutdownSignal:signal},
  approvedMethod:async()=>({approval,signal,check:()=>{}}),broker})
 const target={owner:'a',name:'x',revision,url:resource,identity,requestId:'start-device',approvalId:approval.approvalId}
 try {
  if(first==='browser'){
   await expect(oauth.start('a','x',revision,signal)).resolves.toMatchObject({status:{state:'waiting'}})
   await expect(device.fallback.start(target,signal)).rejects.toThrow('custody unavailable')
   expect(broker.start).not.toHaveBeenCalled()
   expect((await db.execute('SELECT slot FROM desktop_mcp_device_custody')).rows).toHaveLength(0)
   await oauth.cancel('a','x',revision,signal)
   await expect(device.fallback.start(target,signal)).resolves.toMatchObject({state:'waiting'})
  } else {
   await expect(device.fallback.start(target,signal)).resolves.toMatchObject({state:'waiting'})
   await expect(oauth.start('a','x',revision,signal)).rejects.toThrow('already in progress')
   expect(json).not.toHaveBeenCalled()
   await device.stop(approval)
   await expect(oauth.start('a','x',revision,signal)).resolves.toMatchObject({status:{state:'waiting'}})
  }
 } finally {device.dispose()}
})

it('cancels an interrupted browser reservation only from its saved chat attempt', async () => {
 const {db,store,revision,oauth}=await setup()
 const signal=new AbortController().signal, row=await store.read('a','x')
 const reservation={owner:'a',name:'x',registrationId:row.id!,revision,method:'browser' as const,attemptId:'saved-chat'}
 const attempts=createMcpOAuthAttempts(db)
 await attempts.reserve(reservation,Date.now()+300_000)
 await oauth.cancel('a','x',revision,signal,'old-chat')
 await expect(attempts.assertCurrent(reservation)).resolves.toBeUndefined()
 await oauth.cancel('a','x',revision,signal,'saved-chat')
 await expect(oauth.start('a','x',revision,signal)).resolves.toMatchObject({status:{state:'waiting'}})
})

it('reports a verified device credential after an older browser attempt failed', async () => {
 const {store,revision,oauth,json}=await setup()
 const signal=new AbortController().signal
 vi.mocked(json).mockRejectedValue(new Error('fixture browser unavailable'))
 await expect(oauth.start('a','x',revision,signal)).resolves.toMatchObject({status:{state:'unsupported'}})
 await expect(oauth.status('a','x',revision,signal)).resolves.toMatchObject({state:'unsupported'})
 await store.writeOAuth('a','x',revision,{accessToken:'device-fixture',expiresAt:Date.now()+3_600_000,resource,issuer,tokenEndpoint:issuer+'token',clientId:'device-client'},signal)
 await expect(oauth.status('a','x',revision,signal)).resolves.toEqual({state:'connected'})
})

it('rolls back a browser token if its reservation expires before the credential transaction', async () => {
 const {db,store,revision,oauth,exchanges}=await setup()
 const signal=new AbortController().signal, row=await store.read('a','x')
 const replacement={owner:'a',name:'x',registrationId:row.id!,revision,method:'device' as const,attemptId:'new-device'}
 const afterDeadline=()=>Date.now()+301_000
 const attempts=createMcpOAuthAttempts(db,afterDeadline)
 const replace=store.replaceOAuth.bind(store)
 vi.spyOn(store,'replaceOAuth').mockImplementationOnce(async (...args)=>{
  await attempts.reserve(replacement,afterDeadline()+120_000)
  return replace(...args)
 })
 const started=await oauth.start('a','x',revision,signal)
 const response=callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(()=>expect(response.writeHead).toHaveBeenCalledWith(400,expect.anything()))
 expect(exchanges()).toBe(1)
 expect(await store.readOAuth('a','x')).toBeNull()
 await expect(attempts.assertCurrent(replacement)).resolves.toBeUndefined()
})

it('finished attempts do not exhaust the active listener budget',async()=>{
 const {store}=await setup()
 const unavailable=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),async()=>{throw new Error('Unavailable')});services.push(unavailable)
 for(let index=0;index<129;index++){
  const name=`server-${index}`
  await store.save('a',{name,url:resource})
  const revision=(await store.read('a',name)).revision
  expect((await unavailable.start('a',name,revision,new AbortController().signal)).status.state).toBe('unsupported')
 }
 const last=await store.read('a','server-128')
 expect((await unavailable.start('a','server-128',last.revision,new AbortController().signal)).status.state).toBe('unsupported')
})

it('restores connected state from encrypted storage after service restart while preserving configured bearer servers',async()=>{
 const {oauth,revision,store,db,json}=await setup()
 const started=await oauth.start('a','x',revision,new AbortController().signal)
 callback(new URL(started.authorizationUrl!).searchParams.get('state')!)
 await vi.waitFor(async()=>expect((await oauth.status('a','x',revision,new AbortController().signal)).state).toBe('connected'))
 await store.save('a',{name:'bearer',url:resource,bearer:'configured-secret'})
 oauth.shutdown()
 const restored=remoteMcpStore(db,()=>Buffer.alloc(32,7)),next=loopbackMcpOAuth(restored,async()=>({enabled:true,granted:true}),json);services.push(next)
 expect(await next.status('a','x',revision,new AbortController().signal)).toEqual({state:'connected'})
 expect(await next.credential('a','x',revision,new AbortController().signal)).toBe('access')
 const bearer=await restored.read('a','bearer')
 expect(await next.credential('a','bearer',bearer.revision,new AbortController().signal)).toBeNull()
 await expect(next.start('a','bearer',bearer.revision,new AbortController().signal)).rejects.toThrow('bearer')
 expect((await restored.read('a','bearer')).bearer).toBe('configured-secret')
})

it('keeps a durable uncertain refresh receipt after cancellation and refuses replay after restart',async()=>{
 const {store,revision,db,json}=await setup()
 await store.writeOAuth('a','x',revision,{accessToken:'old',refreshToken:'rotating',expiresAt:1,resource,issuer,tokenEndpoint:issuer+'token',clientId:'public-client'},new AbortController().signal)
 let entered!:()=>void,finish!:(value:Record<string,unknown>)=>void
 const exchanging=new Promise<void>(resolve=>{entered=resolve})
 const delayed:OAuthJson=(url,signal,body)=>body instanceof URLSearchParams && body.get('grant_type')==='refresh_token'?new Promise(resolve=>{finish=resolve;entered()}):json(url,signal,body)
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),delayed);services.push(oauth)
 const controller=new AbortController(),pending=oauth.credential('a','x',revision,controller.signal),rejected=expect(pending).rejects.toThrow()
 await exchanging;controller.abort();await rejected
 finish({access_token:'late-token',refresh_token:'new-rotation',expires_in:3600,token_type:'Bearer'});await flush()
 const saved=await store.readOAuth('a','x')
 expect(saved?.refreshPending).toBeTruthy();expect(saved?.accessToken).toBe('old')
 oauth.shutdown()
 const next=loopbackMcpOAuth(remoteMcpStore(db,()=>Buffer.alloc(32,7)),async()=>({enabled:true,granted:true}),json);services.push(next)
 expect((await next.status('a','x',revision,new AbortController().signal)).state).toBe('error')
 await expect(next.credential('a','x',revision,new AbortController().signal)).rejects.toThrow('acknowledgement')
})

it('restores the exact refresh receipt when cancellation arrives after SQLite replaced its ciphertext',async()=>{
 const {store,revision,db}=await setup()
 const previous={accessToken:'old',refreshToken:'rotating',refreshPending:'unconfirmed-rotation',expiresAt:1,resource,issuer,tokenEndpoint:issuer+'token',clientId:'public-client'}
 await store.writeOAuth('a','x',revision,previous,new AbortController().signal)
 const ciphertext=String((await db.execute('SELECT bundle FROM desktop_remote_mcp_oauth')).rows[0].bundle)
 const stop=new AbortController(),execute=db.execute.bind(db)
 vi.spyOn(db,'execute').mockImplementation(async input=>{
  const result=await execute(input)
  if(typeof input!=='string' && (input as import('@libsql/client').InStatement & {sql:string}).sql.startsWith('INSERT INTO desktop_remote_mcp_oauth'))stop.abort()
  return result
 })
 await expect(store.writeOAuth('a','x',revision,{...previous,refreshPending:undefined,accessToken:'cancelled-new-token'},stop.signal)).rejects.toThrow()
 expect(await store.readOAuth('a','x')).toEqual(previous)
 expect(String((await db.execute('SELECT bundle FROM desktop_remote_mcp_oauth')).rows[0].bundle)).toBe(ciphertext)
})
