// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { IsolatedScreenDialog } from './IsolatedScreenDialog'
const sessions = vi.hoisted(() => ({ connect: vi.fn(), finish: vi.fn(), close: vi.fn(), cancelConnection: vi.fn() }))
vi.mock('@/lib/desktop/screen-session', () => ({ createDesktopScreenSession: () => sessions }))
vi.mock('@/components/desktop/DesktopViewer', () => ({ DesktopViewer: () => <div>Browser pixels</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root=undefined;vi.resetAllMocks();document.body.innerHTML='' })
for (const unavailable of [false,true]) test(`original dialog renders requested takeover with unavailable=${unavailable}`,async()=>{
 sessions.connect.mockResolvedValue(unavailable?{unavailable:'Test unavailable'}:{socketUrl:'ws://127.0.0.1/test'})
 sessions.close.mockResolvedValue(undefined)
 root=createRoot(document.body.appendChild(document.createElement('div')))
 await act(async()=>root!.render(<IsolatedScreenDialog open agentId="owner" title="Test browser" onOpenChange={()=>{}} takeover={{callId:'request',reason:'Review QA browser'}} onHandBack={async()=>{}}/>))
 expect(document.body.textContent).toContain(unavailable?'Test unavailable':'Browser pixels')
})
