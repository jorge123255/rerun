import {createClient} from '@libsql/client'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {migrateDesktopSse} from '../mcp-sse/schema'
import {remoteMcpStore,remoteMcpSchema,remoteMcpOAuthSchema} from './store'
import {loopbackMcpOAuth} from './oauth-loopback'
import {OAuthTransportError,type OAuthDeviceForm} from './oauth-network'
import {GITHUB_DEVICE_CODE_URL,GITHUB_MCP_SCOPES,GITHUB_SIGN_IN_UNAVAILABLE,GITHUB_TOKEN_URL,githubDeviceClientId,vaultSignInPlan} from './github-device'

// A fake GitHub: no network, no account. Every value below is a fixture.
const resource='https://api.githubcopilot.com/mcp/'
const clientId='Ov23liFIXTURE0000001'
const deviceCode='fixture-device-code-never-shown'
const accessToken='gho_fixtureTokenNeverShown0001'
const userCode='WDJB-MJHT'
type Answer=Record<string,unknown>|Error
function fakeGitHub(answers:Answer[],start:Answer={device_code:deviceCode,user_code:userCode,verification_uri:'https://github.com/login/device',expires_in:900,interval:5}) {
 const calls:{url:string;body:URLSearchParams}[]=[]
 const form:OAuthDeviceForm=vi.fn(async(url,_signal,body)=>{
  calls.push({url,body})
  const answer=url===GITHUB_DEVICE_CODE_URL?start:answers.shift()??{error:'authorization_pending'}
  if(answer instanceof Error)throw answer
  return {status:200,body:answer}
 })
 return {form,calls}
}
const clients:ReturnType<typeof createClient>[]=[],roots:string[]=[],services:ReturnType<typeof loopbackMcpOAuth>[]=[]
afterEach(async()=>{for(const s of services.splice(0))s.shutdown();for(const db of clients.splice(0))db.close();await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));vi.restoreAllMocks();vi.unstubAllEnvs()})

async function setup(answers:Answer[],options:{start?:Answer;holdAfter?:number}={}) {
 const root=await mkdtemp(join(tmpdir(),'rerun-github-device-'));roots.push(root)
 const file=join(root,'app.db'),db=createClient({url:`file:${file}`});clients.push(db)
 await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES ('a');"+remoteMcpSchema+remoteMcpOAuthSchema)
 await migrateDesktopSse(db)
 const store=remoteMcpStore(db,()=>Buffer.alloc(32,7));await store.save('a',{name:'github',url:resource})
 const revision=(await store.list('a'))[0].revision
 const github=fakeGitHub(answers,options.start)
 const sleeps:number[]=[]
 // The poller's waits resolve at once, except the one a test holds to act while a sign-in is waiting.
 let release!:()=>void
 const held=new Promise<void>(resolve=>{release=resolve})
 const sleep=vi.fn(async(ms:number,signal:AbortSignal)=>{
  sleeps.push(ms)
  if(options.holdAfter!==undefined && sleeps.length>options.holdAfter)await Promise.race([held,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))])
  signal.throwIfAborted()
 })
 const json=vi.fn(async()=>{throw new Error('Discovery must not run for GitHub')})
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),json,store,undefined,vaultSignInPlan(clientId,github.form,sleep));services.push(oauth)
 const signal=new AbortController().signal
 const status=()=>oauth.status('a','github',revision,signal)
 return {db,file,store,revision,oauth,signal,status,sleeps,release,json,answers,...github}
}

it('pending, then slow down, then success: stores a non-expiring token and uses it as the bearer',async()=>{
 const t=await setup([{error:'authorization_pending'},{error:'slow_down',interval:10},{access_token:accessToken,token_type:'bearer',scope:'repo,read:org'}])
 const started=await t.oauth.start('a','github',t.revision,t.signal)
 expect(started).toEqual({status:{state:'waiting',device:{userCode,verificationUri:'https://github.com/login/device'}}})
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'connected'}))
 // GitHub's interval, then 5 seconds more after slow_down (GitHub asked for 10, which matches).
 expect(t.sleeps).toEqual([5000,5000,10_000])
 expect(t.calls.map(call=>call.url)).toEqual([GITHUB_DEVICE_CODE_URL,GITHUB_TOKEN_URL,GITHUB_TOKEN_URL,GITHUB_TOKEN_URL])
 expect(Object.fromEntries(t.calls[0].body)).toEqual({client_id:clientId,scope:GITHUB_MCP_SCOPES.join(' ')})
 expect(Object.fromEntries(t.calls[1].body)).toEqual({client_id:clientId,device_code:deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'})
 expect(t.calls.some(call=>call.body.has('client_secret'))).toBe(false)
 expect(t.json).not.toHaveBeenCalled()
 const saved=await t.store.readOAuth('a','github')
 expect(saved).toMatchObject({accessToken,resource,neverExpires:true,signIn:'github-device',clientId,scope:'repo,read:org'})
 expect(saved?.refreshToken).toBeUndefined()
 // No expiry, no refresh token: still a usable credential, long after an ordinary token would have expired.
 vi.spyOn(Date,'now').mockReturnValue(Date.now()+400*86400_000)
 expect(await t.oauth.credential('a','github',t.revision,t.signal)).toBe(accessToken)
 expect(await t.status()).toEqual({state:'connected'})
 vi.mocked(Date.now).mockRestore()
 // Encrypted at rest, and never in what the renderer is given.
 expect((await readFile(t.file)).includes(accessToken)).toBe(false)
 expect(JSON.stringify([started,await t.status()])).not.toMatch(new RegExp(`${accessToken}|${deviceCode}`))
})

it('declined on GitHub ends with a plain message and stops polling',async()=>{
 const t=await setup([{error:'authorization_pending'},{error:'access_denied',error_description:'raw provider words'}])
 await t.oauth.start('a','github',t.revision,t.signal)
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'error',message:'Sign-in was declined on GitHub.'}))
 expect(t.calls).toHaveLength(3)
 expect(await t.store.readOAuth('a','github')).toBeNull()
 expect(JSON.stringify(await t.status())).not.toContain('raw provider words')
})

it('an expired code ends with its own message',async()=>{
 const t=await setup([{error:'expired_token'}])
 await t.oauth.start('a','github',t.revision,t.signal)
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'error',message:'The code expired before it was entered on GitHub. Start again.'}))
})

it.each([
 [{error:'device_flow_disabled'},'unsupported','The GitHub sign-in app of this copy of Rerun does not have Device Flow turned on.'],
 [{error:'incorrect_client_credentials'},'unsupported','GitHub does not recognise the sign-in app of this copy of Rerun.'],
 [new OAuthTransportError('OAuth endpoint refused request','refused'),'error','GitHub refused to start sign-in for this copy of Rerun.'],
 [new OAuthTransportError('OAuth request cancelled or unavailable','unreachable'),'error','Rerun could not reach GitHub. Check the internet connection and retry.'],
 [{device_code:deviceCode,user_code:userCode,verification_uri:'https://github.com.evil.example/login/device',expires_in:900,interval:5},'error','GitHub sent a sign-in page outside github.com. Sign-in was stopped.'],
 [{device_code:deviceCode,user_code:userCode,verification_uri:'https://github.com/login/device',interval:5},'error','GitHub’s answer could not be read. Retry in a moment.'],
] as const)('a refused start says why: %j',async(start,state,message)=>{
 const t=await setup([],{start:start as Answer})
 expect(await t.oauth.start('a','github',t.revision,t.signal)).toEqual({status:{state,message}})
 expect(await t.status()).toEqual({state,message})
 expect(t.calls).toHaveLength(1)
})

it('the token GitHub returns must be a usable bearer token',async()=>{
 const t=await setup([{access_token:accessToken,token_type:'mac'}])
 await t.oauth.start('a','github',t.revision,t.signal)
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'error',message:'The token GitHub returned is not usable.'}))
 expect(await t.store.readOAuth('a','github')).toBeNull()
})

it('cancel stops the poller, and a second start while one runs is refused',async()=>{
 const t=await setup([],{holdAfter:1})
 const first=await t.oauth.start('a','github',t.revision,t.signal)
 expect(first.status.state).toBe('waiting')
 await expect(t.oauth.start('a','github',t.revision,t.signal)).rejects.toThrow('already in progress')
 await vi.waitFor(()=>expect(t.sleeps).toHaveLength(2))
 const polls=t.calls.length
 await t.oauth.cancel('a','github',t.revision,t.signal)
 expect(await t.status()).toEqual({state:'idle'})
 t.release()
 await new Promise(resolve=>setTimeout(resolve,20))
 expect(t.calls).toHaveLength(polls)
 expect(await t.store.readOAuth('a','github')).toBeNull()
 // After a cancel a new sign-in can start.
 expect((await t.oauth.start('a','github',t.revision,t.signal)).status.state).toBe('waiting')
})

it('a token the MCP server refuses asks to sign in again, once, without a loop',async()=>{
 const t=await setup([{access_token:accessToken,token_type:'bearer'}])
 await t.oauth.start('a','github',t.revision,t.signal)
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'connected'}))
 const polls=t.calls.length
 expect(await t.oauth.reject('a','github','some-other-token',t.signal)).toBe(false)
 expect(await t.oauth.reject('a','github',accessToken,t.signal)).toBe(true)
 const again={state:'error',message:'GitHub no longer accepts this sign-in. Sign in again.',reconnect:true}
 expect(await t.status()).toEqual(again)
 await expect(t.oauth.credential('a','github',t.revision,t.signal)).rejects.toThrow('Sign in again')
 // Marked once; nothing retries on its own.
 expect(await t.oauth.reject('a','github',accessToken,t.signal)).toBe(false)
 expect(await t.status()).toEqual(again)
 expect(t.calls).toHaveLength(polls)
 // Signing in again and being declined shows the decline, not the older refusal.
 t.answers.push({error:'access_denied'})
 expect((await t.oauth.start('a','github',t.revision,t.signal)).status.state).toBe('waiting')
 await vi.waitFor(async()=>expect(await t.status()).toEqual({state:'error',message:'Sign-in was declined on GitHub.'}))
})

it('without a client ID the sign-in is not offered, and a saved entry says why before any attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rerun-github-device-'));roots.push(root)
 const db=createClient({url:`file:${join(root,'app.db')}`});clients.push(db)
 await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES ('a');"+remoteMcpSchema+remoteMcpOAuthSchema)
 await migrateDesktopSse(db)
 const store=remoteMcpStore(db,()=>Buffer.alloc(32,7));await store.save('a',{name:'github',url:resource})
 const revision=(await store.list('a'))[0].revision,signal=new AbortController().signal
 const form=vi.fn<OAuthDeviceForm>(),json=vi.fn()
 const oauth=loopbackMcpOAuth(store,async()=>({enabled:true,granted:true}),json,store,undefined,vaultSignInPlan(null,form));services.push(oauth)
 const reason={state:'unsupported',message:GITHUB_SIGN_IN_UNAVAILABLE}
 expect(await oauth.status('a','github',revision,signal)).toEqual(reason)
 expect(await oauth.start('a','github',revision,signal)).toEqual({status:reason})
 expect(form).not.toHaveBeenCalled();expect(json).not.toHaveBeenCalled()
})

it('reads the client ID only from the staged value',()=>{
 expect(githubDeviceClientId(undefined)).toBeNull()
 expect(githubDeviceClientId('')).toBeNull()
 expect(githubDeviceClientId('not a client id')).toBeNull()
 expect(githubDeviceClientId(clientId)).toBe(clientId)
 vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID',clientId)
 expect(githubDeviceClientId()).toBe(clientId)
 expect(vaultSignInPlan()('https://api.githubcopilot.com/mcp/').kind).toBe('github-device')
 expect(vaultSignInPlan()('https://mcp.cloudflare.com/mcp').kind).toBe('loopback')
 vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID','')
 expect(vaultSignInPlan()('https://api.githubcopilot.com/mcp/')).toEqual({kind:'unavailable',message:GITHUB_SIGN_IN_UNAVAILABLE})
})
