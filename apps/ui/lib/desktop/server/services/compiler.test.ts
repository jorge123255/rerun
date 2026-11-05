import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {serviceManifestSchema} from '@/lib/services/manifest'
import {compileLocalService} from './compiler'
const microsoft=serviceManifestSchema.parse({slug:'microsoft',name:'Microsoft Learn',category:'dev',mcpServers:[{name:'microsoft-learn',transport:'http',url:'https://learn.microsoft.com/api/mcp'}]})
it('supports the real legacy Microsoft Learn anonymous shape without inventing a method',()=>{
 expect(microsoft.authMethods[0].kind).toBe('key')
 const compiled=compileLocalService(microsoft,'default',{}, {id:'default',supported:true})
 expect(compiled.plan.serverName).toBe('microsoft-learn');expect(compiled.plan.key).toBe('microsoft');expect(compiled.bearer).toBe('')
 expect(()=>compileLocalService(microsoft,'invented',{}, {id:'invented',supported:true})).toThrow()
})
it('rejects empty OAuth, unsupported transport, hosted authority and unknown inputs',()=>{
 for(const server of [{...microsoft.authMethods[0].mcpServers[0],oauth:{}},{...microsoft.authMethods[0].mcpServers[0],transport:'sse'},{...microsoft.authMethods[0].mcpServers[0],url:'https://rerun.build/api/hub'}]){
  const manifest=serviceManifestSchema.parse({...microsoft,authMethods:[{...microsoft.authMethods[0],mcpServers:[server]}]})
  expect(()=>compileLocalService(manifest,'default',{}, {id:'default',supported:true})).toThrow()
 }
 expect(()=>compileLocalService(microsoft,'default',{secret:'example'}, {id:'default',supported:true})).toThrow()
})
it('keeps a single Bearer fixture out of the compiled plan',()=>{
 const manifest=serviceManifestSchema.parse({...microsoft,authMethods:[{id:'token',kind:'key',inputs:[{key:'TOKEN',label:'Token',type:'password',secret:true,required:true}],mcpServers:[{name:'fixture',transport:'http',url:'https://example.com/mcp',headers:{Authorization:'Bearer ${input.TOKEN}'}}]}]})
 const result=compileLocalService(manifest,'token',{TOKEN:'fixture-not-a-real-key'}, {id:'token',supported:true})
 expect(result.bearer).toBe('fixture-not-a-real-key');expect(JSON.stringify(result.plan)).not.toContain('fixture-not-a-real-key')
})
