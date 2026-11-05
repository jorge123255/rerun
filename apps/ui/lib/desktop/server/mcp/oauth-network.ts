import 'server-only'
import {lookup} from 'node:dns/promises'
import {request} from 'node:https'
import {BlockList,isIP} from 'node:net'
import {abortable} from './remote'
const blocked=new BlockList()
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.51.100.0',24],['203.0.113.0',24],['198.18.0.0',15],['224.0.0.0',3]] as const)blocked.addSubnet(ip,prefix,'ipv4')
for(const [ip,prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2001::',32],['2002::',16]] as const)blocked.addSubnet(ip,prefix,'ipv6')
export function oauthHttps(value:string) {
 const url=new URL(value)
 if(url.protocol!=='https:' || url.username || url.password || url.hash || url.port && url.port!=='443')throw new Error('Unsupported OAuth destination')
 return url
}
export async function publicOAuthAddress(value:string,signal:AbortSignal) {
 const url=oauthHttps(value),host=url.hostname.replace(/^\[|\]$/g,'')
 const addresses=await abortable(isIP(host)?Promise.resolve([{address:host,family:isIP(host)}]):lookup(host,{all:true}),signal)
 signal.throwIfAborted()
 if(!addresses.length || addresses.some(a=>blocked.check(a.address,a.family===6?'ipv6':'ipv4')))throw new Error('Unsupported OAuth destination')
 return addresses[0]
}
export type OAuthJson=(url:string,signal:AbortSignal,body?:URLSearchParams|Record<string,unknown>)=>Promise<Record<string,unknown>>
export const oauthJson:OAuthJson=async(value,stop,body)=>{
 const signal=AbortSignal.any([stop,AbortSignal.timeout(10_000)])
 const url=oauthHttps(value),address=await publicOAuthAddress(value,signal)
 const bytes=body?Buffer.from(body instanceof URLSearchParams?body.toString():JSON.stringify(body)):undefined
 if(bytes && bytes.length>32_768)throw new Error('OAuth request exceeds limit')
 signal.throwIfAborted()
 return new Promise((resolve,reject)=>{
  const req=request(url,{method:body?'POST':'GET',signal,family:address.family,autoSelectFamily:false,lookup:((_host:unknown,_options:unknown,done:(error:null,address:string,family:number)=>void)=>done(null,address.address,address.family)) as any,headers:{Accept:'application/json',...(bytes?{'Content-Type':body instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json','Content-Length':String(bytes.length)}:{})}},res=>{
   if(!res.statusCode || res.statusCode<200 || res.statusCode>=300 || !res.headers['content-type']?.toLowerCase().startsWith('application/json')){res.destroy();reject(new Error('OAuth endpoint refused request'));return}
   let count=0;const chunks:Buffer[]=[]
   res.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>65_536){res.destroy(new Error('OAuth response exceeds limit'));return}chunks.push(chunk)})
   res.on('error',()=>reject(new Error('OAuth response unavailable')))
   res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();resolve(data)}catch{reject(new Error('Invalid OAuth response'))}})
  })
  req.on('error',()=>reject(new Error('OAuth request cancelled or unavailable')))
  req.end(bytes)
 })
}
export type OAuthMetadata={resource:string;issuer:string;authorization:string;token:string;registration:string;scope?:string}
export async function discoverLoopbackOAuth(resource:string,signal:AbortSignal,json:OAuthJson=oauthJson):Promise<OAuthMetadata> {
 const url=oauthHttps(resource)
 const path=url.pathname.replace(/\/+$/,'')
 let prm:Record<string,unknown>|undefined
 for(const candidate of [...(path?[`${url.origin}/.well-known/oauth-protected-resource${path}`]:[]),`${url.origin}/.well-known/oauth-protected-resource`]){
  try{prm=await json(candidate,signal);break}catch{signal.throwIfAborted()}
 }
 if(!prm || prm.resource!==resource || !Array.isArray(prm.authorization_servers) || prm.authorization_servers.length!==1 || typeof prm.authorization_servers[0]!=='string')throw new Error('Unsupported: exact resource metadata and one authorization server required')
 const issuer=oauthHttps(prm.authorization_servers[0]).href,base=new URL(issuer),suffix=base.pathname.replace(/\/+$/,'')
 let meta:Record<string,unknown>|undefined
 for(const candidate of [`${base.origin}/.well-known/oauth-authorization-server${suffix}`,`${base.origin}/.well-known/openid-configuration${suffix}`]){
  try{meta=await json(candidate,signal);break}catch{signal.throwIfAborted()}
 }
 if(!meta || meta.authorization_response_iss_parameter_supported!==true || meta.issuer!==prm.authorization_servers[0] || !Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes('S256') || !Array.isArray(meta.response_types_supported) || !meta.response_types_supported.includes('code') || !Array.isArray(meta.token_endpoint_auth_methods_supported) || !meta.token_endpoint_auth_methods_supported.includes('none'))throw new Error('Unsupported: public authorization-code PKCE required')
 function endpoint(key:string){const value=meta![key];if(typeof value!=='string' || oauthHttps(value).origin!==base.origin)throw new Error('Unsupported OAuth endpoint identity');return value}
 const scopes=prm.scopes_supported
 if(scopes!==undefined && (!Array.isArray(scopes) || scopes.length>64 || scopes.some(s=>typeof s!=='string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s))))throw new Error('Invalid resource scopes')
 return {resource,issuer:String(prm.authorization_servers[0]),authorization:endpoint('authorization_endpoint'),token:endpoint('token_endpoint'),registration:endpoint('registration_endpoint'),scope:(scopes as string[]|undefined)?.join(' ')}
}
