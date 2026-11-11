import 'server-only'
import {lookup} from 'node:dns/promises'
import {request} from 'node:https'
import {BlockList,isIP} from 'node:net'
import {abortable} from './remote'
import type {DeviceOAuthClient} from './model'
import {approvedDeviceMethodSchema,parsePrivate,type ApprovedDeviceMethod} from '../mcp-device-custody/model'
const blocked=new BlockList()
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.88.99.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.51.100.0',24],['203.0.113.0',24],['198.18.0.0',15],['224.0.0.0',3]] as const)blocked.addSubnet(ip,prefix,'ipv4')
const globalV6=new BlockList()
globalV6.addSubnet('2000::',3,'ipv6')
for(const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)blocked.addSubnet(ip,prefix,'ipv6')
export function oauthHttps(value:string) {
 if(value.length>8192 || /[\u0000-\u0020\u007f]/.test(value))throw new Error('Unsupported OAuth destination')
 const url=new URL(value)
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'')
 if(url.protocol!=='https:' || url.username || url.password || url.hash || url.port && url.port!=='443' || host.endsWith('.') || host.includes('%') || /(^|\.)(localhost|local|internal)$/.test(host))throw new Error('Unsupported OAuth destination')
 return url
}
export async function publicOAuthAddress(value:string,signal:AbortSignal) {
 const url=oauthHttps(value),host=url.hostname.replace(/^\[|\]$/g,'')
 const addresses=await abortable(isIP(host)?Promise.resolve([{address:host,family:isIP(host)}]):lookup(host,{all:true}),signal)
 signal.throwIfAborted()
 if(!addresses.length || addresses.some(a=>a.family===6 ? !globalV6.check(a.address,'ipv6') || blocked.check(a.address,'ipv6') : a.family!==4 || blocked.check(a.address,'ipv4')))throw new Error('Unsupported OAuth destination')
 return addresses[0]
}
export type OAuthJson=(url:string,signal:AbortSignal,body?:URLSearchParams|Record<string,unknown>)=>Promise<Record<string,unknown>>
type OAuthResponse = { status: number; body: Record<string, unknown> }
export type OAuthDeviceForm = (url: string, signal: AbortSignal, body: URLSearchParams, acceptTokenError: boolean) => Promise<OAuthResponse>
async function oauthResponse(value:string,stop:AbortSignal,body?:URLSearchParams|Record<string,unknown>,acceptTokenError=false):Promise<OAuthResponse>{
 const signal=AbortSignal.any([stop,AbortSignal.timeout(10_000)])
 const url=oauthHttps(value),address=await publicOAuthAddress(value,signal)
 const bytes=body?Buffer.from(body instanceof URLSearchParams?body.toString():JSON.stringify(body)):undefined
 if(bytes && bytes.length>32_768)throw new Error('OAuth request exceeds limit')
 signal.throwIfAborted()
 return new Promise((resolve,reject)=>{
  // Node supports autoSelectFamily; the installed HTTPS RequestOptions declaration predates it.
  // Keeping the options in a structural value preserves the runtime flag and pinned lookup.
  const connectionOptions={method:body?'POST':'GET',signal,family:address.family,autoSelectFamily:false,lookup:((_host:unknown,_options:unknown,done:(error:null,address:string,family:number)=>void)=>done(null,address.address,address.family)) as import('node:http').RequestOptions['lookup'],headers:{Accept:'application/json',...(bytes?{'Content-Type':body instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json','Content-Length':String(bytes.length)}:{})}}
  const req=request(url,connectionOptions,res=>{
   const status = res.statusCode ?? 0
   const success = status >= 200 && status < 300
   const json = res.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
   if ((!success && !(acceptTokenError && status === 400)) || !json) {
    res.destroy()
    reject(new Error('OAuth endpoint refused request'))
    return
   }
   let count=0;const chunks:Buffer[]=[]
   res.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>65_536){res.destroy(new Error('OAuth response exceeds limit'));return}chunks.push(chunk)})
   res.on('error',()=>reject(new Error('OAuth response unavailable')))
   res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();resolve({status,body:data})}catch{reject(new Error('Invalid OAuth response'))}})
  })
  req.on('error',()=>reject(new Error('OAuth request cancelled or unavailable')))
  req.end(bytes)
 })
}
export const oauthJson:OAuthJson=async (url,signal,body)=>(await oauthResponse(url,signal,body)).body
export const oauthDeviceForm:OAuthDeviceForm=(url,signal,body,acceptTokenError)=>oauthResponse(url,signal,body,acceptTokenError)
export type OAuthMetadata={resource:string;issuer:string;authorization:string;token:string;registration:string;scope?:string}
export const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'
async function discoverOAuthMetadata(resource:string,signal:AbortSignal,json:OAuthJson,expectedOrigin?:string) {
 const url=oauthHttps(resource)
 const path=url.pathname.replace(/\/+$/,'')
 let prm:Record<string,unknown>|undefined
 for(const candidate of [...(path?[`${url.origin}/.well-known/oauth-protected-resource${path}`]:[]),`${url.origin}/.well-known/oauth-protected-resource`]){
  try{prm=await json(candidate,signal);break}catch{signal.throwIfAborted()}
 }
 if(!prm || prm.resource!==resource || !Array.isArray(prm.authorization_servers) || prm.authorization_servers.length!==1 || typeof prm.authorization_servers[0]!=='string')throw new Error('Unsupported: exact resource metadata and one authorization server required')
 const issuer=oauthHttps(prm.authorization_servers[0]).href,base=new URL(issuer),suffix=base.pathname.replace(/\/+$/,'')
 let meta:Record<string,unknown>|undefined
 if(base.search || expectedOrigin && base.origin!==expectedOrigin)throw new Error('Unsupported OAuth issuer')
 for(const candidate of new Set([`${base.origin}/.well-known/oauth-authorization-server${suffix}`,`${base.origin}/.well-known/openid-configuration${suffix}`,`${base.origin}${suffix}/.well-known/openid-configuration`])){
  try{meta=await json(candidate,signal);break}catch{signal.throwIfAborted()}
 }
 if(!meta || meta.issuer!==prm.authorization_servers[0] || !Array.isArray(meta.token_endpoint_auth_methods_supported) || !meta.token_endpoint_auth_methods_supported.includes('none'))throw new Error('Unsupported: exact issuer and public client required')
 function endpoint(key:string){const value=meta![key];if(typeof value!=='string' || oauthHttps(value).origin!==base.origin)throw new Error('Unsupported OAuth endpoint identity');return value}
 const scopes=prm.scopes_supported
 if(scopes!==undefined && (!Array.isArray(scopes) || scopes.length>64 || scopes.some(s=>typeof s!=='string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s))))throw new Error('Invalid resource scopes')
 signal.throwIfAborted()
 return {meta,endpoint,issuer:String(prm.authorization_servers[0]),scope:(scopes as string[]|undefined)?.join(' ')}
}
export async function discoverLoopbackOAuth(resource:string,signal:AbortSignal,json:OAuthJson=oauthJson):Promise<OAuthMetadata> {
 const {meta,endpoint,issuer,scope}=await discoverOAuthMetadata(resource,signal,json)
 if(meta.authorization_response_iss_parameter_supported!==true || !Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes('S256') || !Array.isArray(meta.response_types_supported) || !meta.response_types_supported.includes('code'))throw new Error('Unsupported: public authorization-code PKCE required')
 return {resource,issuer,authorization:endpoint('authorization_endpoint'),token:endpoint('token_endpoint'),registration:endpoint('registration_endpoint'),scope}
}

export function deviceOAuthClient(input: unknown): DeviceOAuthClient {
 if(!input || typeof input!=='object' || !('clientId' in input) || !('verificationUri' in input)
     || Object.keys(input).length!==2 || typeof input.clientId!=='string' || !/^[\x21-\x7e]{1,256}$/.test(input.clientId)
     || typeof input.verificationUri!=='string' || input.verificationUri.length>4096)throw new Error('Use a public OAuth client and verification page')
 const uri=oauthHttps(input.verificationUri)
 if(uri.search)throw new Error('Use a verification page without a code or query')
 return {clientId:input.clientId,verificationUri:uri.href}
}

/** The public client and verification page come from the exact saved registration. */
export async function discoverDeviceOAuth(resource:string,config:DeviceOAuthClient,signal:AbortSignal,json:OAuthJson=oauthJson):Promise<ApprovedDeviceMethod> {
 const client=deviceOAuthClient(config), origin=new URL(client.verificationUri).origin
 const {meta,endpoint,issuer,scope}=await discoverOAuthMetadata(resource,signal,json,origin)
 if(!Array.isArray(meta.grant_types_supported) || !meta.grant_types_supported.includes(deviceGrant))throw new Error('Provider does not advertise the device grant')
 return parsePrivate(approvedDeviceMethodSchema,{
  kind:'device-code-rfc8628-v1',resource,issuer,deviceEndpoint:endpoint('device_authorization_endpoint'),
  tokenEndpoint:endpoint('token_endpoint'),...client,...(scope?{scope}:{}),
 })
}
