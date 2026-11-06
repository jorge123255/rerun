// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { usePushToTalk } from '@/components/foreman/dock/usePushToTalk'
import { shouldPushToTalk } from '@/lib/foreman/push-to-talk'
;(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let dispose:(()=>Promise<void>)|undefined
afterEach(async()=>{await dispose?.();document.body.innerHTML='';vi.useRealTimers()})
test('original 200ms guard respects controls, dialogs, composition and aborts a lost hold',async()=>{
 vi.useFakeTimers();const start=vi.fn(),release=vi.fn(),abort=vi.fn(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 function Harness(){usePushToTalk({enabled:true,onStart:start,onRelease:release,onAbort:abort});return null}
 dispose=async()=>{await act(async()=>root.unmount())}
 await act(async()=>root.render(<Harness/>))
 const key=(type:string,extra:KeyboardEventInit={})=>window.dispatchEvent(new KeyboardEvent(type,{code:'Space',bubbles:true,cancelable:true,...extra}))
 await act(async()=>{key('keydown');vi.advanceTimersByTime(199);key('keyup')});expect(start).not.toHaveBeenCalled()
 const input=document.body.appendChild(document.createElement('input'));input.focus()
 await act(async()=>{key('keydown');vi.advanceTimersByTime(250);key('keyup')});expect(start).not.toHaveBeenCalled();input.blur()
 const dialog=document.body.appendChild(document.createElement('div'));dialog.setAttribute('role','dialog')
 await act(async()=>{key('keydown');vi.advanceTimersByTime(250);key('keyup')});expect(start).not.toHaveBeenCalled();dialog.remove()
 await act(async()=>{key('keydown');vi.advanceTimersByTime(200);window.dispatchEvent(new Event('blur'))});expect(start).toHaveBeenCalledOnce();expect(abort).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled()
 expect(shouldPushToTalk({code:'Space',repeat:false,isComposing:true,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false},{focusHeld:false,overlayOpen:false})).toBe(false)
})
