import 'server-only'
import {createHash,randomUUID} from 'node:crypto'
import {desktopServiceOAuthActionSchema,type DesktopServiceOAuthAction,type DesktopServiceOAuthState} from '@rerun/contracts'
import {canonical} from '../accounts/installs'
import {compileCatalogOAuth} from './compiler'
import {oauthHttps,publicOAuthAddress} from '../../mcp/oauth-network'
import type {OAuthAccountBinding,OAuthAccounts,OAuthAttempt,OAuthAttemptStore,OAuthPrimitive,OAuthPrimitiveFactory,ApprovedOAuthBrowser} from './ports'
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const text:Record<DesktopServiceOAuthState,string>={configured:'Configuration saved. Connect to sign in.',starting:'Discovering OAuth provider...',waiting:'Waiting for authorization…',checking:'Sign-in saved. Check the connection.',connected:'Connected',cancelled:'Authorization cancelled. Retry.',expired:'Authorization expired. Retry.',error:'Authorization or connection failed. Retry.',unsupported:'This provider requires unsupported local OAuth features.',interrupted:'Authorization acknowledgement unavailable. Reconnect explicitly.',disconnected:'Local credentials removed. This does not revoke the provider credential.'}
const activeStates=new Set(['starting','waiting','checking','connected'])
export function serviceOAuthLifecycle(accounts:OAuthAccounts,store:OAuthAttemptStore,factory:OAuthPrimitiveFactory,browser:ApprovedOAuthBrowser,now:()=>number=Date.now){
 const engines=new Map<string,OAuthPrimitive>(),shutdown=new AbortController()
 async function guard(attempt:OAuthAttempt,signal:AbortSignal,use=true){
  signal.throwIfAborted();shutdown.signal.throwIfAborted()
  const current=await accounts.current(attempt.binding.owner,attempt.binding.accountKey,signal)
  if(digest(current.binding)!==digest(attempt.binding)||use&&(!current.enabled||!current.granted))throw new Error('OAuth account authority changed')
  const saved=await store.read(attempt.binding.owner,attempt.snapshot.attemptId)
  if(!saved||saved.fingerprint!==attempt.fingerprint||use&&!activeStates.has(saved.snapshot.state))throw new Error('OAuth attempt is no longer active')
  signal.throwIfAborted()
  return current
 }
 const engine=(attempt:OAuthAttempt)=>{
  let primitive=engines.get(attempt.snapshot.attemptId)
  if(!primitive){primitive=factory(attempt,signal=>guard(attempt,signal).then(()=>{}));engines.set(attempt.snapshot.attemptId,primitive)}
  return primitive
 }
 async function transition(attempt:OAuthAttempt,state:DesktopServiceOAuthState,extra:{configured?:boolean;probePending?:boolean}={}){
  const revision=attempt.snapshot.revision
  attempt.snapshot={...attempt.snapshot,state,revision:randomUUID(),message:text[state],installed:state==='connected',...(extra.configured!==undefined?{configured:extra.configured}:{})}
  if(extra.probePending!==undefined)attempt.probePending=extra.probePending
  await store.save(attempt,revision)
  return attempt.snapshot
 }
 function fresh(owner:string,requestId:string,binding:OAuthAccountBinding,state:DesktopServiceOAuthState):OAuthAttempt{
  return {version:1,requestId,fingerprint:digest([owner,requestId,binding,state]),binding,probePending:false,snapshot:{attemptId:randomUUID(),revision:randomUUID(),coworkerId:owner,installationId:binding.installationId,accountKey:binding.accountKey,label:binding.label,methodId:binding.methodId,configGeneration:binding.configGeneration,state,expiresAt:now()+300000,configured:false,installed:false,message:text[state]}}
 }
 async function stop(attempt:OAuthAttempt,state:DesktopServiceOAuthState){
  await transition(attempt,'cancelled') // Persist invalidation before closing callback or clearing credentials.
  engines.get(attempt.snapshot.attemptId)?.shutdown();engines.delete(attempt.snapshot.attemptId)
  await store.clearToken(attempt)
  await transition(attempt,state,{configured:false})
 }
 async function action(owner:string,raw:DesktopServiceOAuthAction,stopSignal:AbortSignal){
  const input=desktopServiceOAuthActionSchema.parse(raw),signal=AbortSignal.any([stopSignal,shutdown.signal,AbortSignal.timeout(45000)])
  signal.throwIfAborted()
  if(input.action==='current'){const current=await accounts.current(owner,input.accountKey,signal);const matches=(await store.list(owner)).filter(a=>a.binding.installationId===current.binding.installationId&&a.binding.configGeneration===current.binding.configGeneration);const attempt=matches.find(a=>activeStates.has(a.snapshot.state))??matches.at(-1);if(!attempt)throw new Error('OAuth account has no saved sign-in setup');await guard(attempt,signal,false);return attempt.snapshot}
  if(input.action==='lookup'){const attempt=(await store.list(owner)).find(a=>a.requestId===input.requestId);if(!attempt)throw new Error('OAuth attempt unavailable');await guard(attempt,signal,false);return attempt.snapshot}
  if(input.action==='configure'){
   if(input.intent.kind!=='existing'&&input.intent.slug!==input.slug)throw new Error('Catalog identity changed')
   const manifest=await accounts.catalog(input.slug);if(!manifest)throw new Error('Unknown catalog service')
   const plan=compileCatalogOAuth(manifest,input.methodId)
   if(input.intent.kind==='existing'){const old=await accounts.current(owner,input.intent.accountKey,signal);if(old.binding.configGeneration!==input.intent.expectedRevision||old.binding.methodId!==plan.methodId||old.binding.catalogFingerprint!==plan.fingerprint)throw new Error('Existing OAuth configuration changed; preserve it and configure a separate account')}
   const binding=await accounts.configure(owner,input.requestId,input.intent,plan,signal)
   if(binding.owner!==owner||binding.methodId!==plan.methodId||binding.endpoint!==plan.endpoint||binding.catalogFingerprint!==plan.fingerprint||binding.transport!==plan.transport)throw new Error('OAuth configuration mismatch')
   const reserved=await store.reserve(fresh(owner,input.requestId,binding,'configured'))
   await guard(reserved.attempt,signal,false)
   return reserved.attempt.snapshot
  }
  if(input.action==='start'){
   const current=await accounts.current(owner,input.accountKey,signal)
   if(current.binding.owner!==owner||current.binding.configGeneration!==input.expectedGeneration||!current.enabled||!current.granted)throw new Error('OAuth account authority changed')
   const reservation=await accounts.exclusive(owner,current.binding.installationId,async()=>{
    const candidate=fresh(owner,input.requestId,current.binding,'starting')
    const same=(await store.list(owner)).find(a=>a.requestId===input.requestId)
    if(same){if(same.fingerprint!==candidate.fingerprint)throw new Error('OAuth request identity conflict');return {created:false,attempt:same}}
    for(const old of await store.list(owner))if(old.binding.installationId===current.binding.installationId&&activeStates.has(old.snapshot.state))await stop(old,'cancelled')
    return store.reserve(candidate)
   })
   if(!reservation.created){if(reservation.attempt.snapshot.state==='connected'&&!current.healthy)return transition(reservation.attempt,'checking');return reservation.attempt.snapshot} // A lost ACK never launches sign-in again.
   const attempt=reservation.attempt
   try{
    await guard(attempt,signal)
    const result=await engine(attempt).start(signal)
    await guard(attempt,signal)
    if(!result.authorizationUrl){return await transition(attempt,result.status.state==='unsupported'?'unsupported':'error')}
    oauthHttps(result.authorizationUrl);await publicOAuthAddress(result.authorizationUrl,signal)
    await transition(attempt,'waiting')
    await guard(attempt,signal);await browser(result.authorizationUrl,signal);await guard(attempt,signal)
    return attempt.snapshot
   }catch{
    engines.get(attempt.snapshot.attemptId)?.shutdown();engines.delete(attempt.snapshot.attemptId)
    // Another mutation may already have cancelled this revision. Never overwrite it.
    const saved=await store.read(owner,attempt.snapshot.attemptId)
    if(saved?.snapshot.revision===attempt.snapshot.revision)await transition(attempt,'error')
    throw new Error('OAuth sign-in unavailable. Refresh this account and retry explicitly.')
   }
  }
  const attempt=await store.read(owner,input.attemptId)
  if(!attempt||attempt.snapshot.coworkerId!==owner||attempt.snapshot.revision!==input.expectedRevision)throw new Error('OAuth attempt revision changed')
  const authority=await guard(attempt,signal,false)
  if(attempt.snapshot.state==='connected'&&!authority.healthy&&input.action==='status')return transition(attempt,'checking')
  if(input.action==='cancel'||input.action==='disconnect')return accounts.exclusive(owner,attempt.binding.installationId,async()=>{
   const other=(await store.list(owner)).some(a=>a.binding.installationId===attempt.binding.installationId&&a.snapshot.attemptId!==attempt.snapshot.attemptId&&activeStates.has(a.snapshot.state))
   if(other)throw new Error('A newer OAuth attempt owns this account')
   await guard(attempt,signal,false);await stop(attempt,input.action==='cancel'?'cancelled':'disconnected')
   if(input.action==='disconnect')await accounts.disconnect(attempt.binding,signal)
   return attempt.snapshot
  })
  if(!activeStates.has(attempt.snapshot.state))return attempt.snapshot
  if(attempt.snapshot.state==='connected'&&input.action==='status'){const status=await engine(attempt).status(signal);if(status.state!=='connected')return transition(attempt,'error',{configured:true})}
  if(attempt.snapshot.state==='waiting'||attempt.snapshot.state==='starting'){
   if(now()>=attempt.snapshot.expiresAt){await stop(attempt,'expired');return attempt.snapshot}
   const primitive=engines.get(attempt.snapshot.attemptId)
   if(!primitive)return transition(attempt,'interrupted')
   const status=await primitive.status(signal)
   if(status.state==='connected')return transition(attempt,'checking',{configured:true})
   if(status.state==='error'||status.state==='unsupported')return transition(attempt,status.state)
   return attempt.snapshot
  }
  if(input.action==='probe'){
   if(attempt.probePending)return transition(attempt,'interrupted')
   await guard(attempt,signal)
   await transition(attempt,'checking',{probePending:true})
   try{
    const credential=async()=>{await guard(attempt,signal);const value=await engine(attempt).credential(signal);if(!value)throw new Error('OAuth credential unavailable');return value}
    const result=await accounts.readiness(attempt.binding,credential,signal)
    await guard(attempt,signal)
    if(!result.healthy)throw new Error('OAuth readiness failed')
    return transition(attempt,'connected',{configured:true,probePending:false})
   }catch{const saved=await store.read(owner,attempt.snapshot.attemptId);if(saved?.snapshot.revision!==attempt.snapshot.revision)throw new Error('OAuth attempt changed');return transition(attempt,signal.aborted?'interrupted':'error',{configured:true})}
  }
  return attempt.snapshot
 }
 return {action,
  // Called BEFORE canonical account reconfigure/remove, sharing its mutation serialization.
  async invalidateAccount(owner:string,installationId:string){for(const attempt of await store.list(owner))if(attempt.binding.installationId===installationId)await stop(attempt,'disconnected')},
  async suspendOwner(owner:string){for(const attempt of await store.list(owner)){engines.get(attempt.snapshot.attemptId)?.shutdown();engines.delete(attempt.snapshot.attemptId);if(activeStates.has(attempt.snapshot.state))await transition(attempt,attempt.snapshot.state==='connected'?'checking':'interrupted',{configured:attempt.snapshot.configured})}},
  async reconcile(){
   for(const attempt of await store.list())if(activeStates.has(attempt.snapshot.state)){let token:Awaited<ReturnType<OAuthAttemptStore['readToken']>>=null;try{token=await store.readToken(attempt)}catch{}await transition(attempt,token&&!token.refreshPending&&!attempt.probePending?'checking':'interrupted',{configured:!!token})}
  },
  async credential(owner:string,attemptId:string,signal:AbortSignal){const attempt=await store.read(owner,attemptId);if(!attempt||attempt.snapshot.state!=='connected')throw new Error('OAuth account is not connected');await guard(attempt,signal);const value=await engine(attempt).credential(signal);await guard(attempt,signal);if(!value)throw new Error('OAuth credential unavailable');return value},
  shutdown(){shutdown.abort();for(const primitive of engines.values())primitive.shutdown();engines.clear()},
 }
}
