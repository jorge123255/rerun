import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async(host:string)=>host==='mixed.example'?[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}])}))
import {discoverLoopbackOAuth,oauthHttps,publicOAuthAddress,type OAuthJson} from './oauth-network'
it('refuses non-HTTPS, credentialed, nonstandard-port, private, mapped and mixed DNS destinations',async()=>{
 for(const value of ['http://example.com','https://user:secret@example.com','https://example.com:8443','https://example.com/#fragment','https://localhost','https://router.local','https://service.internal','https://example.com.','https://exam\nple.com'])expect(()=>oauthHttps(value)).toThrow()
 for(const value of ['https://127.0.0.1','https://10.1.2.3','https://192.88.99.1','https://[::ffff:127.0.0.1]','https://[fec0::1]','https://[64:ff9b::a00:1]','https://[2001:20::1]','https://[3fff::1]','https://mixed.example'])await expect(publicOAuthAddress(value,new AbortController().signal)).rejects.toThrow()
 expect(await publicOAuthAddress('https://public.example',new AbortController().signal)).toEqual({address:'93.184.216.34',family:4})
 expect(await publicOAuthAddress('https://[2606:4700:4700::1111]',new AbortController().signal)).toEqual({address:'2606:4700:4700::1111',family:6})
})

it('discovers a path-based OIDC issuer without falling back to another issuer',async()=>{
 const resource='https://mcp.example/mcp',issuer='https://auth.example/tenant'
 const json:OAuthJson=vi.fn(async url=>{
  if(url==='https://mcp.example/.well-known/oauth-protected-resource/mcp')return {resource,authorization_servers:[issuer]}
  if(url===issuer+'/.well-known/openid-configuration')return {issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',registration_endpoint:issuer+'/register',token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],response_types_supported:['code'],authorization_response_iss_parameter_supported:true}
  throw new Error('Not found')
 })
 expect((await discoverLoopbackOAuth(resource,new AbortController().signal,json)).issuer).toBe(issuer)
 expect(vi.mocked(json).mock.calls.map(call=>call[0])).toEqual(['https://mcp.example/.well-known/oauth-protected-resource/mcp','https://auth.example/.well-known/oauth-authorization-server/tenant','https://auth.example/.well-known/openid-configuration/tenant','https://auth.example/tenant/.well-known/openid-configuration'])
})
