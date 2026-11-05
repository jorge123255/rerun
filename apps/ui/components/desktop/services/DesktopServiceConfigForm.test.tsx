// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>{const install=vi.fn();return {install,driver:{install}}})
vi.mock('@/components/services/service-setup-driver',()=>({useServiceSetupDriver:()=>state.driver}))
import {DesktopServiceConfigForm} from './DesktopServiceConfigForm'
import type {ServiceSetupDriver} from '@/components/services/service-setup-driver'
import type {DesktopServiceDetails} from '@/lib/desktop/services-client'
;(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const roots:{root:Root;host:HTMLElement}[]=[]
afterEach(()=>{for(const {root,host} of roots.splice(0)){act(()=>root.unmount());host.remove()}state.install.mockReset()})
function render(details:DesktopServiceDetails){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push({root,host});act(()=>root.render(<DesktopServiceConfigForm agentId="owner" details={details} localDriver={state.driver as unknown as ServiceSetupDriver} onChanged={async()=>{}} onBusy={()=>{}}/>));return host}
function details(kind:'oauth'|'key'='key',supported=true):DesktopServiceDetails{return {key:'fixture',slug:'fixture',name:'Fixture',category:'dev',summary:'',description:'',icon:null,installed:false,installStatus:null,multiInstance:false,instances:[],installation:null,localLimitations:'Local setup',authMethods:[{id:'exact',label:'Method',kind,recommended:true,requiresSecrets:kind==='key',inputs:kind==='key'?[{key:'TOKEN',label:'Token',type:'password',secret:true,required:true}]:[]}],methodAvailability:[{id:'exact',supported,reason:supported?undefined:'Hosted OAuth is unavailable locally'}]}}
it('never mounts hosted sign-in children for unavailable methods',()=>{
 const host=render(details('oauth',false))
 expect(host.querySelector('input')).toBeNull();expect(host.textContent).toContain('Hosted OAuth is unavailable locally')
 expect([...host.querySelectorAll('button')].some(button=>button.textContent==='Install')).toBe(false)
 expect(state.install).not.toHaveBeenCalled()
})
it('rejects a forged supported OAuth method without invoking the driver',()=>{
 const host=render(details('oauth',true))
 expect(host.querySelector('input')).toBeNull();expect(state.install).not.toHaveBeenCalled()
})
it('does not echo configured credentials into the form',()=>{
 const detail=details();detail.installation={key:'fixture',slug:'fixture',name:'Fixture',category:'dev',icon:null,revision:'r',health:{state:'unchecked'},installed:false,status:'needs_config',authMethodId:'exact',installedAt:'',toolNames:[],configured:{TOKEN:true}}
 const host=render(detail)
 expect(host.textContent).toContain('Credential configured')
 expect(host.querySelector('input[type="password"]')).toBeNull()
})
it('preserves a typed secret after unknown acknowledgement and clears it after acknowledged saved configuration',async()=>{
 state.install.mockResolvedValueOnce({ok:false,error:'unknown acknowledgement'}).mockResolvedValueOnce({ok:true,result:{status:'needs_config'}})
 const host=render(details()),input=host.querySelector('input')!
 act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'fixture-only');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})
 const save=()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Install')!
 await act(async()=>save().click());expect(input.value).toBe('fixture-only')
 await act(async()=>save().click());expect(input.value).toBe('')
})
