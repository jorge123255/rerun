import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async(host:string)=>host==='mixed.example'?[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}])}))
import {oauthHttps,publicOAuthAddress} from './oauth-network'
it('refuses non-HTTPS, credentialed, nonstandard-port, private, mapped and mixed DNS destinations',async()=>{
 for(const value of ['http://example.com','https://user:secret@example.com','https://example.com:8443','https://example.com/#fragment'])expect(()=>oauthHttps(value)).toThrow()
 for(const value of ['https://127.0.0.1','https://10.1.2.3','https://[::ffff:127.0.0.1]','https://mixed.example'])await expect(publicOAuthAddress(value,new AbortController().signal)).rejects.toThrow()
 expect(await publicOAuthAddress('https://public.example',new AbortController().signal)).toEqual({address:'93.184.216.34',family:4})
})
