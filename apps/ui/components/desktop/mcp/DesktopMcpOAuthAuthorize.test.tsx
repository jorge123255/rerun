// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {DesktopMcpOAuthAuthorize} from './DesktopMcpOAuthAuthorize'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined,host:HTMLDivElement|undefined
const props={agentId:'a',name:'server',revision:'f7444d01-185f-4bfc-b97e-49b906257c56'}
function render(next: Parameters<typeof DesktopMcpOAuthAuthorize>[0] = props){host=document.createElement('div');document.body.append(host);root=createRoot(host);act(()=>root!.render(<DesktopMcpOAuthAuthorize {...next}/>))}
function button(name:string){const value=[...host!.querySelectorAll('button')].find(node=>node.textContent?.trim()===name);if(!value)throw new Error(`Missing ${name}`);return value}
async function settle(){await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve()})}
afterEach(()=>{if(root)act(()=>root!.unmount());host?.remove();root=undefined;host=undefined;vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()})

it('reads saved status without starting sign-in and opens only the explicit returned browser link',async()=>{
 const requests=vi.fn(async(_url:string,init:RequestInit)=>{
  const {action}=JSON.parse(String(init.body))
  return Response.json(action==='start'?{status:{state:'waiting'},authorizationUrl:'https://auth.example/authorize?state=opaque'}:action==='cancel'?{state:'idle'}:{state:'idle'})
 })
 vi.stubGlobal('fetch',requests);render();await settle()
 expect(requests.mock.calls.map(call=>JSON.parse(String(call[1].body)).action)).toEqual(['status'])
 act(()=>button('Sign in with browser').click());await settle()
 expect(host!.querySelector('a')?.href).toBe('https://auth.example/authorize?state=opaque')
 expect(host!.querySelector('a')?.target).toBe('_blank')
 act(()=>button('Cancel').click());await settle()
 expect(host!.querySelector('a')).toBeNull()
 expect(requests.mock.calls.map(call=>JSON.parse(String(call[1].body)).action)).toEqual(['status','start','cancel'])
})

it('aborts an old owner response and never shows its connected state for a different coworker',async()=>{
 let finish!:(response:Response)=>void,oldSignal!:AbortSignal
 vi.stubGlobal('fetch',vi.fn((url:string,init:RequestInit)=>{
  if(url.includes('/a/')){oldSignal=init.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve})}
  return Promise.resolve(Response.json({state:'idle'}))
 }))
 render();act(()=>root!.render(<DesktopMcpOAuthAuthorize {...props} agentId="b"/>));await settle()
 expect(oldSignal.aborted).toBe(true)
 await act(async()=>finish(Response.json({state:'connected'})));await settle()
 expect(host!.textContent).not.toContain('Connected')
 expect(button('Sign in with browser').disabled).toBe(false)
})

it('pauses status requests while hidden and restores status on return',async()=>{
 let visible:DocumentVisibilityState='visible'
 vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visible)
 const request=vi.fn(async()=>Response.json({state:'waiting'}));vi.stubGlobal('fetch',request)
 vi.useFakeTimers();render();await settle()
 act(()=>{visible='hidden';document.dispatchEvent(new Event('visibilitychange'))})
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(request).toHaveBeenCalledTimes(1)
 act(()=>{visible='visible';document.dispatchEvent(new Event('visibilitychange'))});await settle()
 expect(request).toHaveBeenCalledTimes(2)
})

it('keeps Cancel available during polling and cancels the pending status read',async()=>{
 let pollSignal!:AbortSignal,reads=0
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
  const {action}=JSON.parse(String(init.body))
  if(action==='cancel')return Response.json({state:'idle'})
  if(++reads===1)return Response.json({state:'waiting'})
  pollSignal=init.signal as AbortSignal
  return new Promise<Response>((_resolve,reject)=>pollSignal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}))
 }))
 vi.useFakeTimers();render();await settle()
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
 expect(button('Cancel').disabled).toBe(false)
 act(()=>button('Cancel').click());await settle()
 expect(pollSignal.aborted).toBe(true)
 expect(button('Sign in with browser').disabled).toBe(false)
})

it('rejects malformed provider state and non-HTTPS links without presenting success',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>Response.json(JSON.parse(String(init.body)).action==='status'?{state:'idle'}:{status:{state:'waiting'},authorizationUrl:'http://127.0.0.1/private'})))
 render();await settle();act(()=>button('Sign in with browser').click());await settle()
 expect(host!.querySelector('a')).toBeNull()
 expect(host!.querySelector('[role="alert"]')).toBeTruthy()
 expect(button('Retry sign-in').disabled).toBe(false)
})


it('offers an explicit reconnect for a signed-in Vault entry and uses the exact entry revision', async () => {
 const requests = vi.fn(async (_url: string, init: RequestInit) => {
  const { action } = JSON.parse(String(init.body))
  return Response.json(action === 'start'
   ? { status: { state: 'waiting' }, authorizationUrl: 'https://auth.example/authorize?state=opaque' }
   : { state: action === 'cancel' ? 'idle' : 'connected' })
 })
 vi.stubGlobal('fetch', requests)
 const vaultId = '7d45fef4-5f63-4ba3-8d2c-4398af2b8bc0'
 render({ vaultId, name: props.name, revision: props.revision })
 await settle()
 expect(host!.textContent).toContain('Connected')
 act(() => button('Reconnect').click())
 await settle()
 expect(host!.querySelector('a')?.href).toBe('https://auth.example/authorize?state=opaque')
 expect(requests.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual(
  ['status', 'start'].map(action => ['/api/desktop/vault/oauth', { id: vaultId, name: props.name, revision: props.revision, action }]),
 )
})

const vaultProps={vaultId:'5c0b2a8e-5f0f-4c56-9e55-3f7c0f1f6a11',name:'github',revision:'f7444d01-185f-4bfc-b97e-49b906257c56'}
it('shows the GitHub code to type and a button to GitHub’s page, then the connected state',async()=>{
 let connected=false
 const requests=vi.fn(async(_url:string,init:RequestInit)=>{
  const {action}=JSON.parse(String(init.body))
  if(action==='start')return Response.json({status:{state:'waiting',device:{userCode:'WDJB-MJHT',verificationUri:'https://github.com/login/device'}}})
  return Response.json(connected?{state:'connected'}:action==='status' && requests.mock.calls.length>1?{state:'waiting',device:{userCode:'WDJB-MJHT',verificationUri:'https://github.com/login/device'}}:{state:'idle'})
 })
 vi.useFakeTimers()
 vi.stubGlobal('fetch',requests);render(vaultProps);await settle()
 act(()=>button('Sign in with browser').click());await settle()
 expect(host!.querySelector('[aria-label="Sign-in code"]')?.textContent).toBe('WDJB-MJHT')
 const link=host!.querySelector('a')!
 expect(link.textContent).toContain('Open GitHub’s sign-in page')
 expect(link.href).toBe('https://github.com/login/device')
 expect(link.target).toBe('_blank')
 expect(button('Cancel')).toBeTruthy()
 connected=true
 await act(async()=>{await vi.advanceTimersByTimeAsync(1600)});await settle()
 expect(host!.textContent).toContain('Connected')
 expect(host!.querySelector('[aria-label="Sign-in code"]')).toBeNull()
})

it('refuses a status carrying anything beyond the code and page, such as a device code',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({state:'waiting',device:{userCode:'WDJB-MJHT',verificationUri:'https://github.com/login/device',deviceCode:'secret'}})))
 render(vaultProps);await settle()
 expect(host!.textContent).not.toContain('WDJB-MJHT')
 expect(host!.textContent).toContain('Vault sign-in is unavailable')
})

it('a sign-in this Mac cannot finish offers the token instead of a retry',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({state:'unsupported',message:'GitHub does not let apps register themselves for sign-in, and this copy of Rerun has no GitHub sign-in app set up. Use a GitHub Personal Access Token instead.'})))
 const onUseToken=vi.fn()
 render({...vaultProps,onUseToken});await settle()
 expect(host!.querySelector('[role="alert"]')?.textContent).toContain('GitHub does not let apps register themselves for sign-in')
 expect(()=>button('Retry sign-in')).toThrow()
 act(()=>button('Use a token instead').click())
 expect(onUseToken).toHaveBeenCalledOnce()
})

it('a refused token asks to sign in again',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({state:'error',message:'GitHub no longer accepts this sign-in. Sign in again.',reconnect:true})))
 render(vaultProps);await settle()
 expect(host!.textContent).toContain('GitHub no longer accepts this sign-in. Sign in again.')
 expect(button('Sign in again').disabled).toBe(false)
})
