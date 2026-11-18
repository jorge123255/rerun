import {createClient} from '@libsql/client'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
type HttpHandler=(req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>void
const http=vi.hoisted(()=>({callback:null as null|HttpHandler}))
vi.mock('node:http',()=>({createServer:(callback:HttpHandler)=>{http.callback=callback;return {once:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),address:()=>({port:49152}),close:()=>{},closeIdleConnections:()=>{},closeAllConnections:()=>{}}}}))
vi.mock('./oauth-network',async original=>({...await original<typeof import('./oauth-network')>(),publicOAuthAddress:vi.fn(async()=>({address:'93.184.216.34',family:4}))}))
import {migrateDesktopSse} from '../mcp-sse/schema'
import {remoteMcpStore,remoteMcpSchema,remoteMcpOAuthSchema} from './store'
import {loopbackMcpOAuth} from './oauth-loopback'
import {discoverLoopbackOAuth,type OAuthJson} from './oauth-network'

// The public discovery documents as GitHub and Cloudflare published them on 2026-11-18. No network.
const githubResource={resource:'https://api.githubcopilot.com/mcp/',authorization_servers:['https://github.com/login/oauth'],scopes_supported:['repo','read:org','read:user','user:email','read:packages','write:packages','read:project','project','gist','notifications'],bearer_methods_supported:['header'],resource_name:'GitHub MCP Server'}
const githubServer={issuer:'https://github.com/login/oauth',authorization_endpoint:'https://github.com/login/oauth/authorize',token_endpoint:'https://github.com/login/oauth/access_token',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token','urn:ietf:params:oauth:grant-type:device_code'],code_challenge_methods_supported:['S256'],device_authorization_endpoint:'https://github.com/login/device/code',authorization_response_iss_parameter_supported:true,scopes_supported:['offline_access']}
const resource='https://mcp.example/mcp',issuer='https://auth.example/'
const goodResource={resource,authorization_servers:[issuer],scopes_supported:['read']}
const goodServer={issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'token',registration_endpoint:issuer+'register',token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],response_types_supported:['code'],authorization_response_iss_parameter_supported:true}
function metadata(prm:Record<string,unknown>|null,as:Record<string,unknown>|null):OAuthJson {
 return async url=>{
  if(url.includes('oauth-protected-resource')){if(!prm)throw new Error('404');return structuredClone(prm)}
  if(url.includes('oauth-authorization-server') || url.includes('openid-configuration')){if(!as)throw new Error('404');return structuredClone(as)}
  throw new Error('unexpected '+url)
 }
}
const signal=new AbortController().signal

it('gives each discovery failure its own plain message',async()=>{
 const cases:[string,OAuthJson,string][]=[
  ['no resource metadata',metadata(null,goodServer),'mcp.example does not publish how to sign in to this server.'],
  ['another resource',metadata({...goodResource,resource:'https://other.example/mcp'},goodServer),'mcp.example describes its sign-in for a different address than this server.'],
  ['two sign-in services',metadata({...goodResource,authorization_servers:[issuer,'https://auth2.example/']},goodServer),'mcp.example does not name exactly one sign-in service.'],
  ['plain HTTP sign-in service',metadata({...goodResource,authorization_servers:['http://auth.example/']},goodServer),'mcp.example names a sign-in service at an address Rerun does not use.'],
  ['no sign-in settings',metadata(goodResource,null),'auth.example does not publish its sign-in settings.'],
  ['issuer mismatch',metadata(goodResource,{...goodServer,issuer:'https://auth.example/other'}),'auth.example\'s sign-in settings do not confirm who issued them.'],
  ['endpoint elsewhere',metadata(goodResource,{...goodServer,token_endpoint:'https://elsewhere.example/token'}),'auth.example\'s sign-in settings point to an address outside auth.example.'],
  ['unreadable scopes',metadata({...goodResource,scopes_supported:['bad scope']},goodServer),'mcp.example lists sign-in permissions Rerun cannot read.'],
  ['no registration',metadata(goodResource,{...goodServer,registration_endpoint:undefined}),'auth.example does not let apps register themselves for sign-in.'],
  ['secret required',metadata(goodResource,{...goodServer,token_endpoint_auth_methods_supported:['client_secret_basic']}),'auth.example does not accept sign-in from an app that cannot keep a secret.'],
  ['no PKCE',metadata(goodResource,{...goodServer,code_challenge_methods_supported:['plain']}),'auth.example does not offer the protected browser sign-in Rerun uses (PKCE).'],
  ['no issuer parameter',metadata(goodResource,{...goodServer,authorization_response_iss_parameter_supported:false}),'auth.example\'s sign-in page does not confirm who issued it.'],
 ]
 const messages:string[]=[]
 for(const [label,json,message] of cases){
  await expect(discoverLoopbackOAuth(resource,signal,json),label).rejects.toThrow(message)
  messages.push(message)
 }
 expect(new Set(messages).size).toBe(cases.length)
 for(const message of messages)expect(message).not.toMatch(/https?:\/\//)
})

it('GitHub, as published, is refused for the reason that matters: no app registration',async()=>{
 await expect(discoverLoopbackOAuth(githubResource.resource,signal,metadata(githubResource,githubServer))).rejects.toThrow('GitHub does not let apps register themselves for sign-in.')
})

it('Cloudflare-style dynamic registration still passes discovery unchanged',async()=>{
 const cf='https://mcp.cloudflare.com/mcp',cfIssuer='https://mcp.cloudflare.com'
 const json=metadata({resource:cf,authorization_servers:[cfIssuer]},{issuer:cfIssuer,authorization_endpoint:cfIssuer+'/oauth/authorize',token_endpoint:cfIssuer+'/token',registration_endpoint:cfIssuer+'/register',token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post','none'],code_challenge_methods_supported:['plain','S256'],response_types_supported:['code'],authorization_response_iss_parameter_supported:true})
 expect(await discoverLoopbackOAuth(cf,signal,json)).toEqual({resource:cf,issuer:cfIssuer,authorization:cfIssuer+'/oauth/authorize',token:cfIssuer+'/token',registration:cfIssuer+'/register',scope:undefined})
})

const clients:ReturnType<typeof createClient>[]=[],roots:string[]=[],services:ReturnType<typeof loopbackMcpOAuth>[]=[]
afterEach(async()=>{for(const s of services.splice(0))s.shutdown();for(const db of clients.splice(0))db.close();await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));vi.restoreAllMocks()})
async function setup(json:OAuthJson,url=resource) {
 const root=await mkdtemp(join(tmpdir(),'rerun-oauth-messages-'));roots.push(root)
 const db=createClient({url:`file:${join(root,'app.db')}`});clients.push(db)
 await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES ('a');"+remoteMcpSchema+remoteMcpOAuthSchema)
 await migrateDesktopSse(db)
 const store=remoteMcpStore(db,()=>Buffer.alloc(32,7));await store.save('a',{name:'x',url})
 const revision=(await store.list('a'))[0].revision
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),json,store);services.push(oauth)
 return {oauth,store,revision,status:()=>oauth.status('a','x',revision,signal)}
}
function callback(params:Record<string,string>) {
 const res={writeHead:vi.fn(),end:vi.fn()}
 http.callback!({method:'GET',headers:{host:'127.0.0.1:49152'},url:'/callback?'+new URLSearchParams(params),socket:{remoteAddress:'127.0.0.1',setTimeout:()=>{},destroy:()=>{}}} as unknown as import('node:http').IncomingMessage,res as unknown as import('node:http').ServerResponse)
 return res
}
function provider(token:Record<string,unknown>|Error,registration:Record<string,unknown>|Error|null=null):OAuthJson {
 const base=metadata(goodResource,goodServer)
 return async(url,s,body)=>{
  if(url.endsWith('register')){if(registration instanceof Error)throw registration;return registration??{client_id:'public-client',token_endpoint_auth_method:'none',redirect_uris:(body as Record<string,unknown>).redirect_uris}}
  if(url.endsWith('token')){if(token instanceof Error)throw token;return token}
  return base(url,s,body)
 }
}

it('a GitHub entry on the loopback flow says why instead of the generic message',async()=>{
 const t=await setup(metadata(githubResource,githubServer),githubResource.resource)
 expect(await t.oauth.start('a','x',t.revision,signal)).toEqual({status:{state:'unsupported',message:'GitHub does not let apps register themselves for sign-in.'}})
 expect(await t.status()).toEqual({state:'unsupported',message:'GitHub does not let apps register themselves for sign-in.'})
})

it.each([
 ['refused registration',provider({},new Error('provider said: client_secret=abc')),'auth.example refused to register Rerun for sign-in.'],
 ['registration that needs a secret',provider({},{client_id:'c',client_secret:'s',token_endpoint_auth_method:'client_secret_basic',redirect_uris:[]}),'auth.example registered Rerun in a way that would need a secret or a different return address.'],
])('registration failures say what happened: %s',async(_label,json,message)=>{
 const t=await setup(json)
 expect(await t.oauth.start('a','x',t.revision,signal)).toEqual({status:{state:'unsupported',message}})
})

const fine={access_token:'fixture-access',token_type:'Bearer',expires_in:3600}
it.each([
 ['declined',fine,(state:string)=>({state,error:'access_denied',iss:issuer}),'Sign-in was declined or cancelled on auth.example.'],
 ['no code',fine,(state:string)=>({state,iss:issuer}),'The sign-in page did not return a sign-in code.'],
 ['no issuer',fine,(state:string)=>({state,code:'fixture-code'}),'The sign-in page did not confirm who issued it.'],
 ['token refused',new Error('invalid_grant: raw words'),(state:string)=>({state,code:'fixture-code',iss:issuer}),'auth.example did not accept the sign-in code. Retry.'],
 ['token without expiry',{access_token:'fixture-access',token_type:'Bearer'},(state:string)=>({state,code:'fixture-code',iss:issuer}),'The token auth.example returned has no usable expiry.'],
 ['not a bearer token',{access_token:'fixture-access',token_type:'mac',expires_in:60},(state:string)=>({state,code:'fixture-code',iss:issuer}),'The token auth.example returned is not usable (not a bearer token).'],
 ['token for another service',{...fine,resource:'https://other.example/mcp'},(state:string)=>({state,code:'fixture-code',iss:issuer}),'The token auth.example returned was issued for a different service.'],
] as const)('callback and token failures say what happened: %s',async(_label,token,params,message)=>{
 const t=await setup(provider(token as Record<string,unknown>|Error))
 const started=await t.oauth.start('a','x',t.revision,signal)
 const state=new URL(started.authorizationUrl!).searchParams.get('state')!
 const res=callback(params(state))
 await vi.waitFor(()=>expect(res.writeHead).toHaveBeenCalledWith(400,expect.anything()))
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'error',message}))
 expect(JSON.stringify(await t.status())).not.toMatch(/fixture-code|fixture-access|raw words/)
 expect(await t.store.readOAuth('a','x')).toBeNull()
})
