import 'server-only'
import {createHash,randomBytes} from 'node:crypto'
import {createServer,type Server} from 'node:http'
import type {RemoteMcpStore,OAuthTokenBundle} from './store'
import {abortable,type McpAccess} from './remote'
import {discoverLoopbackOAuth,oauthJson,publicOAuthAddress,type OAuthJson,type OAuthMetadata} from './oauth-network'
export type OAuthStatus={state:'idle'|'waiting'|'connected'|'error'|'unsupported';message?:string}
type Attempt={controller:AbortController;server?:Server;timer:ReturnType<typeof setTimeout>;status:OAuthStatus;revision:string;url:string;used:boolean;release:()=>void}
export function loopbackMcpOAuth(store:RemoteMcpStore,access:McpAccess,json:OAuthJson=oauthJson) {
 const attempts=new Map<string,Attempt>(),refreshes=new Map<string,Promise<string>>()
 const key=(agent:string,name:string)=>JSON.stringify([agent,name])
 let closed=false
 async function authority(agent:string,name:string,revision:string,signal:AbortSignal,check:()=>void) {
  check();signal.throwIfAborted()
  const [permission,server]=await abortable(Promise.all([access(agent),store.read(agent,name)]),signal)
  check();signal.throwIfAborted()
  if(!permission.enabled || !permission.granted || server.revision!==revision)throw new Error('MCP OAuth authority unavailable')
  return server
 }
 function end(attempt:Attempt,status:OAuthStatus) {
  attempt.status=status;clearTimeout(attempt.timer);attempt.server?.close();attempt.server?.closeIdleConnections();attempt.server?.removeAllListeners?.('request');attempt.controller.abort();attempt.release()
 }
 function tokens(data:Record<string,unknown>,meta:OAuthMetadata,clientId:string,previous?:OAuthTokenBundle):OAuthTokenBundle {
  if(data.resource!==undefined && data.resource!==meta.resource || data.iss!==undefined && data.iss!==meta.issuer)throw new Error('Token identity mismatch')
  if(data.token_type!=='Bearer' && data.token_type!=='bearer')throw new Error('Unsupported token type')
  if(typeof data.access_token!=='string' || !/^[\x21-\x7e]{1,8192}$/.test(data.access_token) || typeof data.expires_in!=='number' || !Number.isFinite(data.expires_in) || data.expires_in<=0 || data.expires_in>365*86400 || data.refresh_token!==undefined && (typeof data.refresh_token!=='string' || data.refresh_token.length>8192) || data.scope!==undefined && (typeof data.scope!=='string' || data.scope.length>8192))throw new Error('Unsupported token bundle')
  return {accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:previous?.refreshToken,expiresAt:Date.now()+data.expires_in*1000,resource:meta.resource,issuer:meta.issuer,tokenEndpoint:meta.token,clientId,scope:typeof data.scope==='string'?data.scope:previous?.scope}
 }
 async function start(agent:string,name:string,revision:string,stop:AbortSignal) {
  if(closed || attempts.size>=128)throw new Error('OAuth unavailable')
  const slot=key(agent,name),old=attempts.get(slot)
  if(old)end(old,{state:'idle'})
  store.lifecycle.disconnect(agent,name)
  const controller=new AbortController(),ticket=store.lifecycle.admit(agent,name,controller)
  const signal=AbortSignal.any([controller.signal,stop,AbortSignal.timeout(30_000)])
  const attempt:Attempt={controller,revision,url:'',used:false,release:ticket.release,status:{state:'waiting'},timer:setTimeout(()=>end(attempt,{state:'error',message:'Authorization expired. Retry.'}),300_000)}
  attempts.set(slot,attempt)
  controller.signal.addEventListener('abort',()=>{if(attempt.status.state==='waiting')end(attempt,{state:'error',message:'Authorization cancelled. Retry.'})},{once:true})
  try {
   const server=await authority(agent,name,revision,signal,ticket.assertCurrent);attempt.url=server.url
   if(server.bearer)throw new Error('Unsupported: clear the configured bearer before OAuth')
   const meta=await discoverLoopbackOAuth(server.url,signal,json)
   const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url')
   let clientId='',redirectUri=''
   const listener=createServer((req,res)=>{
    const answer=(status:number,message:string)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'",'Referrer-Policy':'no-referrer'});res.end(message)}
    req.socket.setTimeout(10_000,()=>req.socket.destroy())
    let url:URL
    try{if((req.url?.length??0)>8192)throw new Error();url=new URL(req.url??'','http://127.0.0.1')}catch{answer(400,'Invalid callback');return}
    if(!redirectUri || req.method!=='GET' || req.headers.host!==new URL(redirectUri).host || url.pathname!=='/callback' || req.socket.remoteAddress!=='127.0.0.1' || url.searchParams.getAll('state').length!==1 || url.searchParams.get('state')!==state || attempt.used){answer(400,'Invalid or expired callback');return}
    attempt.used=true
    listener.close()
    const callbackSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)])
    void (async()=>{
     try {
      ticket.assertCurrent()
      if(url.searchParams.has('error') || url.searchParams.getAll('code').length!==1 || !url.searchParams.get('code') || url.searchParams.getAll('iss').length!==1 || url.searchParams.get('iss')!==meta.issuer)throw new Error('Authorization refused or issuer missing')
      const current=await authority(agent,name,revision,callbackSignal,ticket.assertCurrent)
      if(current.url!==attempt.url)throw new Error('Server changed')
      const token=await json(meta.token,callbackSignal,new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code')!,redirect_uri:redirectUri,client_id:clientId,code_verifier:verifier,resource:meta.resource}))
      await authority(agent,name,revision,callbackSignal,ticket.assertCurrent)
      await abortable(store.writeOAuth(agent,name,revision,tokens(token,meta,clientId),callbackSignal),callbackSignal)
      await authority(agent,name,revision,callbackSignal,ticket.assertCurrent)
      answer(200,'Connected. You can close this window.');end(attempt,{state:'connected'})
     }catch{answer(400,'Authorization failed. Return to Rerun and retry.');end(attempt,{state:'error',message:'Authorization failed. Retry.'})}
    })()
   })
   attempt.server=listener;listener.requestTimeout=10_000;listener.headersTimeout=10_000;listener.maxHeadersCount=32
   await abortable(new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve)}),signal)
   const address=listener.address();if(!address || typeof address==='string')throw new Error('Callback unavailable')
   redirectUri=`http://127.0.0.1:${address.port}/callback`
   const registered=await json(meta.registration,signal,{client_name:'Rerun',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})
   if(typeof registered.client_id!=='string' || !/^[\x21-\x7e]{1,2048}$/.test(registered.client_id) || registered.client_secret!==undefined || registered.token_endpoint_auth_method!=='none' || !Array.isArray(registered.redirect_uris) || registered.redirect_uris.length!==1 || registered.redirect_uris[0]!==redirectUri)throw new Error('Unsupported: dynamic public loopback registration required')
   clientId=registered.client_id
   await authority(agent,name,revision,signal,ticket.assertCurrent)
   await publicOAuthAddress(meta.authorization,signal)
   const url=new URL(meta.authorization)
   for(const [k,v] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:meta.resource,...(meta.scope?{scope:meta.scope}:{})}))url.searchParams.set(k,v)
   await authority(agent,name,revision,signal,ticket.assertCurrent)
   ticket.assertCurrent();signal.throwIfAborted()
   return {authorizationUrl:url.href,status:attempt.status}
  }catch{end(attempt,{state:'unsupported',message:'Unsupported or unavailable provider. Public PKCE and dynamic loopback registration are required.'});return {status:attempt.status}}
 }
 async function status(agent:string,name:string,revision:string,signal:AbortSignal):Promise<OAuthStatus> {
  const check=store.lifecycle.watch(agent,name)
  const server=await authority(agent,name,revision,signal,check)
  const attempt=attempts.get(key(agent,name))
  if(attempt && attempt.revision===revision && attempt.url===server.url && attempt.status.state!=='connected')return attempt.status
  const token=await abortable(store.readOAuth(agent,name),signal);check();signal.throwIfAborted()
  if(token && token.expiresAt<=Date.now()+60_000 && !token.refreshToken)return {state:'error',message:'Authorization expired. Reconnect required.'}
  if(token?.refreshPending)return {state:'error',message:'Refresh acknowledgement unavailable. Reconnect required.'}
  return token?.resource===server.url?{state:'connected'}:{state:'idle'}
 }
 async function credential(agent:string,name:string,revision:string,stop:AbortSignal):Promise<string|null> {
  if(closed)throw new Error('OAuth stopped')
  const controller=new AbortController(),ticket=store.lifecycle.admit(agent,name,controller)
  const signal=AbortSignal.any([stop,controller.signal,AbortSignal.timeout(30_000)])
  try {
   const server=await authority(agent,name,revision,signal,ticket.assertCurrent)
   const token=await abortable(store.readOAuth(agent,name),signal);ticket.assertCurrent()
   if(!token)return null
   const joining=refreshes.get(key(agent,name))
   if(joining){const result=await abortable(joining,signal);await authority(agent,name,revision,signal,ticket.assertCurrent);return result}
   if(token.refreshPending)throw new Error('Refresh acknowledgement unavailable; reconnect required')
   if(token.resource!==server.url)throw new Error('OAuth resource mismatch')
   if(token.expiresAt>Date.now()+60_000)return token.accessToken
   const slot=key(agent,name)
   let pending=refreshes.get(slot)
   if(!pending){
    pending=(async()=>{
     if(!token.refreshToken)throw new Error('Reconnect required')
     const fresh=await discoverLoopbackOAuth(server.url,signal,json)
     if(fresh.issuer!==token.issuer || fresh.token!==token.tokenEndpoint)throw new Error('OAuth issuer changed')
     await authority(agent,name,revision,signal,ticket.assertCurrent)
     await abortable(store.writeOAuth(agent,name,revision,{...token,refreshPending:randomBytes(24).toString('base64url')},signal),signal)
     await authority(agent,name,revision,signal,ticket.assertCurrent)
     const result=await json(token.tokenEndpoint,signal,new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refreshToken,client_id:token.clientId,resource:token.resource}))
     const next=tokens(result,fresh,token.clientId,token)
     await authority(agent,name,revision,signal,ticket.assertCurrent)
     await abortable(store.writeOAuth(agent,name,revision,next,signal),signal)
     await authority(agent,name,revision,signal,ticket.assertCurrent)
     return next.accessToken
    })()
    refreshes.set(slot,pending)
    void pending.finally(()=>{if(refreshes.get(slot)===pending)refreshes.delete(slot)}).catch(()=>{})
   }
   const result=await abortable(pending,signal)
   await authority(agent,name,revision,signal,ticket.assertCurrent)
   return result
  }finally{controller.abort();ticket.release()}
 }
 async function cancel(agent:string,name:string,revision:string,signal:AbortSignal){const check=store.lifecycle.watch(agent,name);await authority(agent,name,revision,signal,check);check();signal.throwIfAborted();const attempt=attempts.get(key(agent,name));if(attempt?.revision===revision)end(attempt,{state:'idle'});store.lifecycle.disconnect(agent,name)}
 return {start,status,credential,cancel,shutdown(){closed=true;for(const attempt of attempts.values())end(attempt,{state:'idle'});attempts.clear();store.lifecycle.shutdown()}}
}
