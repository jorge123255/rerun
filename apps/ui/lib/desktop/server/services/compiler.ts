import 'server-only'
import {serviceRegistryKey,parseServiceRegistryKey,type DesktopServiceMethodAvailability} from '@rerun/contracts'
import {serviceManifestSchema,type ServiceManifest} from '@/lib/services/manifest'
import {endpoint,serverName} from '../mcp/model'
export type ServicePlan={slug:string;key:string;name:string;category:string;icon:string|null;methodId:string;serverName:string;url:string;secretInput?:string;skills:{name:string;description:string;body:string}[]}
export function compileLocalService(raw:ServiceManifest,methodId:string,values:Record<string,string>,availability:DesktopServiceMethodAvailability):{plan:ServicePlan;bearer:string}{
 const manifest=serviceManifestSchema.parse(raw),method=manifest.authMethods.find(m=>m.id===methodId)
 if(manifest.skills.length)throw new Error('Service usage-skill bundles are not available on this Mac yet')
 if(!method || availability.id!==methodId || !availability.supported)throw new Error('This authentication method is unavailable on this Mac')
 if(!['none','key'].includes(method.kind) || method.managed!==undefined || method.composio!==undefined || method.app!==undefined || method.mcpServers.length!==1)throw new Error('Unsupported local service method')
 const server=method.mcpServers[0]
 if(server.transport!=='http' || server.oauth!==undefined || server.command!==undefined || server.args.length || Object.keys(server.env).length || !server.url || server.url.includes('${'))throw new Error('Only one canonical HTTPS Streamable HTTP endpoint is supported')
 const url=endpoint(server.url),parsed=new URL(url)
 if(parsed.href!==server.url || /\/api\/(?:hub|mcp\/(?:managed|composio|apps))(?:\/|$)/.test(parsed.pathname) || /(?:^|\.)rerun\.build$/i.test(parsed.hostname))throw new Error('Hosted service authority is unavailable locally')
 const headers=Object.entries(server.headers),inputs=method.inputs
 let secretInput:string|undefined,bearer=''
 if(method.kind==='none' || inputs.length===0&&headers.length===0){
  if(inputs.length || headers.length || method.envKeys.length || Object.keys(values).length)throw new Error('Unsupported anonymous service configuration')
 }else{
  if(inputs.length!==1 || !inputs[0].secret || headers.length!==1 || headers[0][0]!=='Authorization')throw new Error('One exact Bearer-secret input is required')
  secretInput=inputs[0].key
  if(method.envKeys.some(mapping=>mapping.fromInput!==secretInput))throw new Error('Unsupported environment binding')
  if(headers[0][1]!==`Bearer \${input.${secretInput}}` || Object.keys(values).some(k=>k!==secretInput))throw new Error('Unsupported credential binding')
  bearer=values[secretInput]??''
  if(!/^[\x21-\x7e]{1,8192}$/.test(bearer))throw new Error('A Bearer credential is required')
 }
 const key=serviceRegistryKey(manifest.slug)
 if(parseServiceRegistryKey(key).slug!==manifest.slug || manifest.slug.includes('@'))throw new Error('Invalid service instance')
 if(manifest.skills.length>8 || manifest.skills.some(s=>!s.name || s.name.length>128 || Buffer.byteLength(s.body)>65536 || s.body.includes('${') || s.description.includes('${')))throw new Error('Unsupported service skill template')
 return {plan:{slug:manifest.slug,key,name:manifest.name,category:manifest.category,icon:manifest.icon??null,methodId,serverName:serverName(server.name),url,secretInput,skills:manifest.skills},bearer}
}
export function localMethodAvailability(manifest:ServiceManifest,methodId:string,availability:DesktopServiceMethodAvailability):DesktopServiceMethodAvailability{
 if(manifest.skills.length)return {id:methodId,supported:false,reason:'This app also installs usage skills. Those bundles are not available on this Mac yet.'}
 if(!availability.supported)return availability
 const method=manifest.authMethods.find(value=>value.id===methodId)
 if(!method)return {id:methodId,supported:false,reason:'Unknown authentication method.'}
 try{compileLocalService(manifest,methodId,Object.fromEntries(method.inputs.filter(input=>input.secret).map(input=>[input.key,'local-shape-check'])),availability);return availability}
 catch{return {id:methodId,supported:false,reason:'This method needs unsupported transport, credential bindings, hosted authority or skill templates. Only anonymous or one Bearer HTTPS endpoint is available locally.'}}
}
