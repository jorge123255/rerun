import { expect, test, vi } from 'vitest'
import { createForemanVoiceController } from './controller'
import type { PendingAudio } from './journal'
import type { ForemanVoiceRequest, ForemanVoiceSnapshot } from '../../../../../packages/contracts/src/desktop-foreman-voice'
const id='00000000-0000-4000-8000-000000000001'
const target={chat:{workspaceId:'1',chatId:'fmc_00000000-0000-4000-8000-000000000002'},model:{connectionId:'connection',model:'model'}}
const take={blob:new Blob(['test'],{type:'audio/webm'}),format:{mimeType:'audio/webm',extension:'webm',transcriptionFormat:'webm'},durationMs:900,levels:[0.2]}
function harness(){
 let saved:PendingAudio|null=null,live=true;const calls:ForemanVoiceRequest[]=[],accepted=vi.fn()
 const snapshot=(request:ForemanVoiceRequest):ForemanVoiceSnapshot=>({target,attempt:{attemptId:id,revision:'00000000-0000-4000-8000-000000000003',phase:request.action==='send'?'sent':request.action==='transcribe'?'ready':'review',recording:{attemptId:id,sha256:'a'.repeat(64),byteLength:4,mimeType:'audio/webm',extension:'webm',transcriptionFormat:'webm',durationMs:900,levels:[0.2]},transcript:['transcribe','send'].includes(request.action)?'Only voice words':null,error:null,messageId:null,updatedAt:'now'},receipt:request.action==='send'?{target,attemptId:id,requestId:id,runId:id,accepted:true}:null,setup:null})
 const recorder={start:vi.fn(async()=>true),stop:vi.fn(async()=>take),cancel:vi.fn(async()=>{})}
 const journal={read:vi.fn(async()=>saved),put:vi.fn(async(p:PendingAudio)=>{saved=p}),clear:vi.fn(async()=>{saved=null})}
 const client={request:vi.fn(async(r:ForemanVoiceRequest)=>{calls.push(r);return snapshot(r)})}
 const ports={recorder,journal,client,uuid:()=>id,current:()=>live,onAccepted:accepted,releasePolicy:'send' as const}
 return{ports,client,recorder,journal,calls,accepted,setLive:(v:boolean)=>{live=v},saved:()=>saved,controller:createForemanVoiceController(target,ports),snapshot}
}
test('press/release persists audio before transcribing and sends only voice under the same identity',async()=>{
 const h=harness();await h.controller.restore();await h.controller.start();await h.controller.release()
 expect(h.calls.map(x=>x.action)).toEqual(['upload','transcribe','send'])
 expect(h.calls.every(x=>x.attemptId===id)).toBe(true);expect(h.journal.put).toHaveBeenCalledOnce();expect(h.accepted).toHaveBeenCalledOnce()
 expect(JSON.stringify(h.calls)).not.toContain('existing typed draft')
})
test('restoration reads the same attempt without recording, transcription, sending or acceptance callbacks',async()=>{
 const h=harness();await h.controller.restore();await h.controller.start();await h.controller.release(true)
 h.calls.length=0
 const next=createForemanVoiceController(target,h.ports);await next.restore()
 expect(h.calls.map(x=>x.action)).toEqual(['read']);expect(h.recorder.start).toHaveBeenCalledTimes(1);expect(h.accepted).not.toHaveBeenCalled()
})
test('blur/close while microphone opens drains a late recorder and never dispatches',async()=>{
 const h=harness();let opened!:(v:boolean)=>void;h.recorder.start.mockImplementation(()=>new Promise<boolean>(resolve=>{opened=resolve}))
 await h.controller.restore();const pending=h.controller.start();await h.controller.close();opened(true);await pending
 expect(h.recorder.cancel).toHaveBeenCalled();expect(h.calls).toHaveLength(0)
})
test('a model/workspace switch invalidates a late upload before transcription and preserves the saved blob',async()=>{
 const h=harness();let reply!:(v:ForemanVoiceSnapshot)=>void,entered!:()=>void
 const requested=new Promise<void>(resolve=>{entered=resolve})
 h.client.request.mockImplementation(r=>{h.calls.push(r);entered();return new Promise(resolve=>{reply=resolve})})
 await h.controller.restore();await h.controller.start();const released=h.controller.release()
 await requested
 h.setLive(false);reply(h.snapshot(h.calls[0]));await released
 expect(h.calls.map(x=>x.action)).toEqual(['upload']);expect(h.saved()?.blob).toBeInstanceOf(Blob)
})
test('lost send ACK recovers by read without another turn or follow-up callback',async()=>{
 const h=harness();h.client.request.mockImplementation(async r=>{h.calls.push(r);if(r.action==='send')throw Error('lost ACK');return h.snapshot(r)})
 await h.controller.restore();await h.controller.start();await h.controller.release();expect(h.controller.getSnapshot().phase).toBe('error')
 h.client.request.mockImplementation(async r=>{h.calls.push(r);return{...h.snapshot(r),receipt:{target,attemptId:id,requestId:id,runId:id,accepted:true}}})
 await h.controller.refresh();expect(h.calls.filter(r=>r.action==='send')).toHaveLength(1);expect(h.accepted).not.toHaveBeenCalled()
})
test('review policy and empty/short captures perform no provider or send work',async()=>{
 const h=harness();await h.controller.restore();await h.controller.start();await h.controller.release(true);expect(h.calls.map(r=>r.action)).toEqual(['upload'])
 const short=harness();short.recorder.stop.mockResolvedValue({...take,durationMs:100});await short.controller.restore();await short.controller.start();await short.controller.release();expect(short.calls).toHaveLength(0)
})
test('failed local custody blocks upload and transcription, and keeps the take for retry',async()=>{
 const h=harness();h.journal.put.mockRejectedValue(Error('disk full'))
 await h.controller.restore();await h.controller.start();await h.controller.release()
 expect(h.calls).toHaveLength(0);expect(h.controller.getSnapshot().pending?.attemptId).toBe(id)
 expect(await h.controller.prepareForQuit()).toBe(false)
})
test('Cancel invalidates a late transcription without sending, and keeps the same attempt',async()=>{
 const h=harness();let finish!:(v:ForemanVoiceSnapshot)=>void,entered!:()=>void
 const requested=new Promise<void>(resolve=>{entered=resolve})
 h.client.request.mockImplementation(async r=>{h.calls.push(r);if(r.action==='transcribe'){entered();return new Promise(resolve=>{finish=resolve})}return h.snapshot(r)})
 await h.controller.restore();await h.controller.start();const releasing=h.controller.release();await requested
 await h.controller.cancel();finish(h.snapshot({action:'transcribe',target,attemptId:id,expectedRevision:id}));await releasing
 expect(h.calls.some(r=>r.action==='send')).toBe(false);expect(h.controller.getSnapshot().pending?.attemptId).toBe(id)
 expect(h.controller.getSnapshot().phase).toBe('review')
})
test('same-ID explicit send retries cannot create a second accepted callback',async()=>{
 const h=harness();await h.controller.restore();await h.controller.start();await h.controller.release()
 await h.controller.send();expect(h.calls.filter(r=>r.action==='send')).toHaveLength(1);expect(h.accepted).toHaveBeenCalledOnce()
})
test('a missing permission take never transcribes or sends',async()=>{
 const h=harness();h.recorder.start.mockResolvedValue(false)
 await h.controller.restore();await h.controller.start();await h.controller.release()
 expect(h.controller.getSnapshot().phase).toBe('error');expect(h.calls).toHaveLength(0)
})
test('Done clears only the acknowledged pending audio and allows the next human capture',async()=>{
 const h=harness();await h.controller.restore();await h.controller.start();await h.controller.release();await h.controller.done()
 expect(h.controller.getSnapshot().pending).toBeNull();expect(h.journal.clear).toHaveBeenCalledWith(id)
 await h.controller.start();expect(h.recorder.start).toHaveBeenCalledTimes(2)
})
