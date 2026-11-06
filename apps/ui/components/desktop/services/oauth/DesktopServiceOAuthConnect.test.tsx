import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import type {ServiceOAuthDriver} from '@/lib/desktop/service-oauth-client'
import {DesktopServiceOAuthConnect} from './DesktopServiceOAuthConnect'
import type {DesktopServiceOAuthSnapshot} from '../../../../../../packages/contracts/src/desktop-service-oauth'
const snapshot:DesktopServiceOAuthSnapshot={attemptId:'00000000-0000-4000-8000-000000000001',revision:'00000000-0000-4000-8000-000000000002',coworkerId:'owner',installationId:'00000000-0000-4000-8000-000000000003',accountKey:'fixture@abc123',label:'Fixture 2',methodId:'oauth',configGeneration:'00000000-0000-4000-8000-000000000004',state:'configured',expiresAt:300000,configured:false,installed:false,message:'Configuration saved. Connect to sign in.'}
it('does not sign in on mount and requires explicit Connect',async()=>{
 const action=vi.fn<ServiceOAuthDriver['action']>(async()=>({...snapshot,state:'waiting' as const,message:'Waiting for authorization…'}))
 const result=render(<DesktopServiceOAuthConnect snapshot={snapshot} driver={{action}}/>)
 expect(action).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Connect'}))
 await waitFor(()=>expect(action).toHaveBeenCalledTimes(1))
 expect(action.mock.calls[0]?.[1]).toMatchObject({action:'start',accountKey:'fixture@abc123',expectedGeneration:snapshot.configGeneration})
 result.unmount()
})
it('does not display a late sign-in result after the selected coworker changes',async()=>{
 let resolve!:(value:DesktopServiceOAuthSnapshot)=>void
 const action=vi.fn<ServiceOAuthDriver['action']>(()=>new Promise<DesktopServiceOAuthSnapshot>(r=>{resolve=r})),changed=vi.fn()
 const view=render(<DesktopServiceOAuthConnect snapshot={snapshot} driver={{action}} onChanged={changed}/>)
 fireEvent.click(screen.getByRole('button',{name:'Connect'}))
 view.rerender(<DesktopServiceOAuthConnect snapshot={{...snapshot,coworkerId:'other'}} driver={{action}} onChanged={changed}/>)
 resolve({...snapshot,state:'connected',installed:true,message:'Connected'})
 await Promise.resolve()
 expect(changed).not.toHaveBeenCalled()
 view.unmount()
})
