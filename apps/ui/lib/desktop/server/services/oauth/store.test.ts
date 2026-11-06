import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {sealHeaderBundle,openStoredHeaderBundle} from '../accounts/header-secret-codec'
import {SERVICE_OAUTH_SCHEMA_SQL} from './store'
it('reuses encrypted account codec with disjoint OAuth installation and token-generation AAD',()=>{
 const key=Buffer.alloc(32,7),owner='owner',installation='oauth:installation',generation='config:attempt'
 const sealed=sealHeaderBundle(key,owner,installation,generation,{headers:{},inputs:{token:'fixture-access-and-refresh'}})
 expect(sealed).not.toContain('fixture-access-and-refresh')
 expect(openStoredHeaderBundle(key,owner,installation,generation,sealed).inputs.token).toBe('fixture-access-and-refresh')
 for(const [o,i,g] of [['sibling',installation,generation],[owner,'installation',generation],[owner,installation,'other-attempt']])expect(()=>openStoredHeaderBundle(key,o,i,g,sealed)).toThrow('Secret write conflict')
})
it('schema keeps one live OAuth attempt per canonical installation without touching header tables',()=>{
 expect(SERVICE_OAUTH_SCHEMA_SQL.join('\n')).toContain('UNIQUE INDEX desktop_service_oauth_active')
 expect(SERVICE_OAUTH_SCHEMA_SQL.join('\n')).not.toContain('desktop_service_header_secrets')
})
