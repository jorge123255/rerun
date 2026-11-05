import type {ChildProcessWithoutNullStreams} from 'node:child_process'
import {afterEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({listing:{status:0,stdout:'456\n',error:undefined as Error|undefined}}))
vi.mock('node:child_process',()=>({spawnSync:()=>state.listing}))
import {stopNativeProcess} from './stop.js'
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
const child=()=>({pid:123,exitCode:null,signalCode:null,kill:vi.fn()} as unknown as ChildProcessWithoutNullStreams)
it('confirms a PTY child outside the exec-server group before allowing capture',async()=>{
 const alive=new Set([123,-123,456]),calls:unknown[]=[]
 vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
  calls.push([pid,signal])
  if(signal==='SIGKILL'){alive.delete(pid);if(pid===-123)alive.delete(123);return true}
  if(signal===0&&!alive.has(pid))throw Object.assign(new Error('gone'),{code:'ESRCH'})
  return true
 })
 await stopNativeProcess(child())
 expect(calls).toContainEqual([456,'SIGKILL'])
 expect(calls).toContainEqual([456,0])
})
it('refuses capture if the detached PTY writer remains alive',async()=>{
 vi.useFakeTimers()
 vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{if(signal===0&&pid!==456)throw Object.assign(new Error('gone'),{code:'ESRCH'});return true})
 const failed=expect(stopNativeProcess(child())).rejects.toThrow('have not stopped')
 await vi.advanceTimersByTimeAsync(3100);await failed
})
it('allows a later drain retry without sending signals to possibly reused process IDs',async()=>{
 vi.useFakeTimers()
 let writerAlive=true
 const kill=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
  if(signal===0&&(!writerAlive||pid!==456))throw Object.assign(new Error('gone'),{code:'ESRCH'})
  return true
 })
 const worker=child()
 const failed=expect(stopNativeProcess(worker)).rejects.toThrow('have not stopped')
 await vi.advanceTimersByTimeAsync(3100);await failed
 Object.assign(worker,{exitCode:0})
 const before=kill.mock.calls.length
 writerAlive=false
 await stopNativeProcess(worker)
 expect(kill.mock.calls.slice(before)).toEqual([[123,0],[-123,0],[456,0]])
})
it('does not mistake an already exited server for proof that all writers exited',async()=>{
 const exited=child();Object.assign(exited,{exitCode:0})
 await expect(stopNativeProcess(exited)).rejects.toThrow('before its writers')
})
