import 'server-only'
import {createHash} from 'node:crypto'
import {serviceManifestSchema,type ServiceManifest} from '@/lib/services/manifest'
import {oauthHttps} from '../../mcp/oauth-network'
import {instanceServerName} from '@/lib/services/instances'
export type CatalogOAuthPlan={slug:string;methodId:string;endpoint:string;transport:'http';serverTemplate:string;fingerprint:string;skills:{name:string;description:string;body:string}[]}
export function compileCatalogOAuth(raw:ServiceManifest,methodId:string):CatalogOAuthPlan{
 const manifest=serviceManifestSchema.parse(raw),method=manifest.authMethods.find(m=>m.id===methodId)
 if(!method||method.kind!=='oauth'||method.managed||method.composio||method.app||method.inputs.length||method.envKeys.length||method.mcpServers.length!==1)throw new Error('Unsupported catalog OAuth method')
 const server=method.mcpServers[0],oauth=server.oauth
 if(!oauth||server.transport!=='http'||!server.url||server.command||server.args.length||Object.keys(server.env).length||Object.keys(server.headers).length)throw new Error('Unsupported catalog OAuth method')
 // The accepted local primitive cannot enforce catalog overrides; never silently discard them.
 if(oauth.clientId!==undefined||oauth.clientSecret!==undefined||oauth.authorizationServer!==undefined||(oauth.scopes?.length??0)>0)throw new Error('Catalog OAuth overrides require another supported local adapter')
 const endpoint=oauthHttps(server.url).href
 if(new URL(endpoint).search||endpoint!==server.url||endpoint.includes('${')||/(?:^|\.)rerun\.build$/i.test(new URL(endpoint).hostname)||/\/api\/(?:hub|mcp\/(?:managed|composio|apps))(?:\/|$)/.test(new URL(endpoint).pathname))throw new Error('Hosted OAuth methods are unavailable locally')
 if(manifest.skills.length>8||manifest.skills.some(s=>!s.name.trim()||s.name.length>128||Buffer.byteLength(s.description)>4096||!s.body.trim()||Buffer.byteLength(s.body)>65536||[s.name,s.description,s.body].some(v=>v.includes('${')||v.includes('\0'))))throw new Error('Unsupported bundled skill plan')
 if(Buffer.byteLength(JSON.stringify(manifest.skills))>262144)throw new Error('Unsupported bundled skill plan')
 const fields={slug:manifest.slug,methodId,endpoint,transport:'http' as const,serverTemplate:server.name,skills:manifest.skills.map(s=>({name:s.name,description:s.description,body:s.body}))}
 return {...fields,fingerprint:createHash('sha256').update(JSON.stringify(fields)).digest('hex')}
}
export function oauthAccountServerName(plan:CatalogOAuthPlan,instanceId?:string){return instanceId?instanceServerName(plan.serverTemplate,instanceId):plan.serverTemplate}
export function catalogOAuthMethods(manifest:ServiceManifest){
 return manifest.authMethods.map(method=>{
  try{compileCatalogOAuth(manifest,method.id);return {id:method.id,supported:true,reason:null}}
  catch{return {id:method.id,supported:false,reason:method.kind==='oauth'?'This provider requires OAuth features unavailable in the local public PKCE adapter.':'Use this method’s existing account adapter; managed and paid methods remain unavailable.'}}
 })
}

export function defaultCatalogOAuthMethod(manifest:ServiceManifest,initialMethodId?:string){
 if(initialMethodId){const exact=manifest.authMethods.find(method=>method.id===initialMethodId);if(!exact)throw new Error('Unknown authentication method');return exact.id}
 const method=manifest.authMethods.find(value=>value.recommended)??manifest.authMethods[0]
 if(!method)throw new Error('No authentication method')
 return method.id
}
