import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {connectorSkillAuthority} from './skill-ownership'
import type {ServiceStore,ServiceInstall} from './store'
import type {ServiceSkillJournal} from './skill-journal'
function fixture(records:ServiceInstall[]=[]){
 const store={forSkillOwnership:async()=>records} as unknown as ServiceStore
 const journal={list:async()=>[]} as unknown as ServiceSkillJournal
 return connectorSkillAuthority(store,journal,async()=>({engineId:'current',skillsRoot:'/unused'}))
}
it.each(['edit','delete','capture','export'] as const)('refuses %s for unknown reserved skills even with missing/forged workspace footprints',async operation=>{
 const authority=fixture()
 await expect(authority.assertUserOperation('owner','svc-untrusted',operation)).rejects.toThrow('Unknown app skill ownership')
 await expect(authority.assertUserOperation('owner','ordinary',operation)).resolves.toEqual({allowed:true,operation})
})
it('preserves legacy owned skills as protected but unverified when canonical reservation is missing',async()=>{
 const record={id:'installation',key:'service',engineId:'old',plan:{name:'App',skills:[{}]},skills:[{slug:'legacy',directoryIdentity:'1:2',manifestVersion:'version',contentHash:'hash'}]} as ServiceInstall
 const authority=fixture([record])
 expect((await authority.projection('owner'))[0]).toMatchObject({slug:'legacy',readOnly:true,exportable:false,verified:false})
 await expect(authority.assertReady('owner','installation')).rejects.toThrow('unverified')
 await expect(authority.assertUserOperation('owner','legacy','edit')).rejects.toThrow('reconciliation')
})
it('does not call a missing installation ready',async()=>{
 await expect(fixture().assertReady('owner','missing')).rejects.toThrow('incomplete')
})
