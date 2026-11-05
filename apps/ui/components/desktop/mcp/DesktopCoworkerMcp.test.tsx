// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const roots:{root:Root;host:HTMLElement}[]=[]
function render(node:ReactNode){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push({root,host});act(()=>root.render(node));return {rerender:(next:ReactNode)=>act(()=>root.render(next))}}
const screen={
 getByLabelText:(pattern:RegExp)=>{const label=[...document.querySelectorAll('label')].find(l=>pattern.test(l.textContent??''))!;return (label.control ?? label.querySelector('input') ?? document.getElementById(label.htmlFor)) as HTMLInputElement},
 queryByRole:(role:string,options?:{name:string})=>[...document.querySelectorAll(role==='button'?'button':`[role="${role}"]`)].find(e=>!options || e.getAttribute('aria-label')===options.name || e.textContent?.trim()===options.name)??null,
 getByRole:(role:string,options?:{name:string})=>{const e=screen.queryByRole(role,options);if(!e)throw new Error('Missing '+role);return e},
 findByRole:async(role:string,options?:{name:string})=>{await act(async()=>{});return screen.getByRole(role,options)},
}
const fireEvent={click:(e:Element)=>act(()=>{(e as HTMLElement).click()}),change:(e:HTMLInputElement,event:{target:{value:string}})=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(e,event.target.value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})}
async function waitFor(check:()=>void){await act(async()=>{});check()}

import { afterEach, describe, expect, it, vi } from 'vitest'
// The slide driver needs browser animation frames; retain the actual panel/editor below.
vi.mock('@/components/ui/panel-steps',()=>({PanelSteps:({children}:{children:ReactNode})=><>{children}</>}))
import { DesktopCoworkerMcp, DesktopMcpServerEditor } from './DesktopCoworkerMcp'

afterEach(()=>{for(const {root,host} of roots.splice(0)){act(()=>root.unmount());host.remove()}vi.unstubAllGlobals()})
describe('MCP editor lifecycle',()=>{
    it('preserves the intended credential after failure and URL correction',async()=>{
        const onSave=vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(undefined)
        render(<DesktopMcpServerEditor onSave={onSave} onBack={()=>{}}/>)
        fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'server'}})
        fireEvent.change(screen.getByLabelText(/^URL/),{target:{value:'https://old.example/mcp'}})
        fireEvent.change(screen.getByLabelText(/^Bearer credential/),{target:{value:'example-credential'}})
        fireEvent.click(screen.getByRole('button',{name:'Save'}))
        await screen.findByRole('alert')
        expect((screen.getByLabelText(/^Bearer credential/) as HTMLInputElement).value).toBe('example-credential')
        fireEvent.change(screen.getByLabelText(/^URL/),{target:{value:'https://fixed.example/mcp'}})
        fireEvent.click(screen.getByRole('button',{name:'Save'}))
        await waitFor(()=>expect(onSave).toHaveBeenCalledTimes(2))
        expect(onSave.mock.calls[1][0].bearer).toBe('example-credential')
    })
    it('prevents navigation during an unresolved save',async()=>{
        let finish!:()=>void
        const onBack=vi.fn(),onSave=()=>new Promise<void>(r=>{finish=r})
        render(<DesktopMcpServerEditor server={{name:'x',url:'https://example.com/mcp',revision:'1',hasBearer:false}} onSave={onSave} onBack={onBack}/>)
        fireEvent.click(screen.getByRole('button',{name:'Save'}))
        expect(screen.queryByRole('button',{name:'Back'})).toBeNull()
        expect(onBack).not.toHaveBeenCalled()
        await act(async()=>finish())
        expect(screen.getByRole('button',{name:'Back'})).toBeTruthy()
    })
    it('does not apply an old coworker save completion to a new coworker editor',async()=>{
        let finish!:(response:Response)=>void
        vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>init.method==='PUT' ? new Promise<Response>(r=>{finish=r}) : Promise.resolve(Response.json([]))))
        const panel=render(<DesktopCoworkerMcp agentId="a"/>)
        fireEvent.click(await screen.findByRole('button',{name:'New'}))
        fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'old'}})
        fireEvent.change(screen.getByLabelText(/^URL/),{target:{value:'https://example.com/mcp'}})
        fireEvent.click(screen.getByRole('button',{name:'Save'}))
        panel.rerender(<DesktopCoworkerMcp agentId="b"/>)
        fireEvent.click(await screen.findByRole('button',{name:'New'}))
        fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'new draft'}})
        await act(async()=>finish(Response.json([{name:'old',url:'https://example.com/mcp',revision:'1',hasBearer:false}])))
        expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('new draft')
    })
})

it('ignores an old probe after editing the same server',async()=>{
 let finish!:(response:Response)=>void
 const old={name:'x',url:'https://example.com/mcp',revision:'1',hasBearer:false}
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>{
  if(init.method==='GET')return Promise.resolve(Response.json([old]))
  if(init.method==='POST')return new Promise<Response>(r=>{finish=r})
  return Promise.resolve(Response.json([{...old,revision:'2'}]))
 }))
 render(<DesktopCoworkerMcp agentId="a"/>);await act(async()=>{})
 fireEvent.click(screen.getByRole('button',{name:'Connect / probe'}))
 fireEvent.click(screen.getByRole('button',{name:'x'}))
 fireEvent.click(screen.getByRole('button',{name:'Save'}));await act(async()=>{})
 await act(async()=>finish(Response.json({tools:[{name:'obsolete'}]})))
 expect(document.body.textContent).not.toContain('obsolete')
 expect((screen.getByRole('button',{name:'Connect / probe'}) as HTMLButtonElement).disabled).toBe(false)
})

for(const outcome of ['empty','failure'] as const)it(`keeps a saved list authoritative after a late initial GET ${outcome}`,async()=>{
 let resolve!:(response:Response)=>void,reject!:(error:Error)=>void
 const initial=new Promise<Response>((yes,no)=>{resolve=yes;reject=no})
 const saved={name:'saved',url:'https://example.com/mcp',revision:'1',hasBearer:false}
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>init.method==='GET'?initial:Promise.resolve(Response.json([saved]))))
 render(<DesktopCoworkerMcp agentId="a"/>)
 fireEvent.click(screen.getByRole('button',{name:'New'}))
 fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'saved'}})
 fireEvent.change(screen.getByLabelText(/^URL/),{target:{value:saved.url}})
 fireEvent.click(screen.getByRole('button',{name:'Save'}));await act(async()=>{})
 expect(screen.getByRole('button',{name:'saved'})).toBeTruthy()
 await act(async()=>{if(outcome==='empty')resolve(Response.json([]));else reject(new Error('old load failed'))})
 expect(screen.getByRole('button',{name:'saved'})).toBeTruthy()
 expect(screen.queryByRole('alert')).toBeNull()
})

for(const exit of ['cancel','failed-save'] as const)it(`retains the useful initial list after ${exit}`,async()=>{
 let finish!:(response:Response)=>void
 const initial=new Promise<Response>(resolve=>{finish=resolve})
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>init.method==='GET'?initial:Promise.resolve(Response.json({error:'save failed'},{status:400}))))
 render(<DesktopCoworkerMcp agentId="a"/>)
 fireEvent.click(screen.getByRole('button',{name:'New'}))
 if(exit==='failed-save'){
  fireEvent.change(screen.getByLabelText(/^Name/),{target:{value:'draft'}})
  fireEvent.change(screen.getByLabelText(/^URL/),{target:{value:'https://example.com/mcp'}})
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await act(async()=>{})
 }
 fireEvent.click(screen.getByRole('button',{name:'Back'}))
 await act(async()=>finish(Response.json([{name:'existing',url:'https://example.com/mcp',revision:'1',hasBearer:false}])))
 expect(screen.getByRole('button',{name:'existing'})).toBeTruthy()
})
