import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const http=vi.hoisted(()=>({callback:null as null|((req:any,res:any)=>void),closed:vi.fn()}))
vi.mock('node:http',()=>({createServer:(callback:(req:any,res:any)=>void)=>{http.callback=callback;return {once:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),address:()=>({port:49152}),close:http.closed,closeIdleConnections:()=>{}}}}))
vi.mock('./oauth-network',async original=>({...await original<typeof import('./oauth-network')>(),publicOAuthAddress:vi.fn(async()=>({address:'93.184.216.34',family:4}))}))
import {remoteMcpStore,remoteMcpSchema,remoteMcpOAuthSchema} from './store'
import {loopbackMcpOAuth} from './oauth-loopback'
import {discoverLoopbackOAuth,type OAuthJson} from './oauth-network'
const clients:ReturnType<typeof createClient>[]=[]
const services:ReturnType<typeof loopbackMcpOAuth>[]=[]
afterEach(()=>{for(const service of services.splice(0))service.shutdown();for(const db of clients.splice(0))db.close();vi.useRealTimers();vi.clearAllMocks()})
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
 const db=createClient({url:'file::memory:'});clients.push(db)
 await db.executeMultiple('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES (\'a\');'+remoteMcpSchema+remoteMcpOAuthSchema)
 const store=remoteMcpStore(db,()=>Buffer.alloc(32,7));await store.save('a',{name:'x',url:resource})
 const revision=(await store.list('a'))[0].revision,fixture_=fixture()
 let granted=true
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted}),fixture_.json);services.push(oauth)
 return {db,store,revision,oauth,...fixture_,revoke:()=>{granted=false}}
}
function callback(state:string,iss=issuer){
 const res={writeHead:vi.fn(),end:vi.fn()}
 http.callback!({method:'GET',headers:{host:'127.0.0.1:49152'},url:'/callback?'+new URLSearchParams({state,code:'example-code',iss}),socket:{remoteAddress:'127.0.0.1',setTimeout:()=>{},destroy:()=>{}}},res)
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
