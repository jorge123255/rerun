import {retainNativeWriteback,acknowledgeNativeWriteback} from './outbox.js'
import {env} from '../../config/env.js'
import {abortable} from '../web-fetch/transport.js'
import type {NativeWritebackBundle} from './capture.js'
export async function persistNativeWriteback(bundle:NativeWritebackBundle,stop:AbortSignal):Promise<void>{
 const retained=await retainNativeWriteback(bundle)
 await sendNativeWriteback(bundle,stop)
 await acknowledgeNativeWriteback(retained,bundle)
}
export async function sendNativeWriteback(bundle:NativeWritebackBundle,stop:AbortSignal):Promise<void>{
 const config=env(),base=new URL(config.RERUN_HUB_BASE_URL??'')
 if(base.protocol!=='http:' || base.hostname!=='127.0.0.1' || !base.port || base.pathname!=='/' || base.username || base.password || base.search || base.hash || !config.RERUN_API_KEY)throw new Error('Writeback callback unavailable')
 const signal=AbortSignal.any([stop,AbortSignal.timeout(30_000)]),body=JSON.stringify(bundle)
 if(Buffer.byteLength(body)>3*1024*1024)throw new Error('Writeback proposal exceeds limit')
 const response=await abortable(fetch(`${base.origin}/api/desktop/engine/native-writeback`,{method:'POST',body,signal,redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${config.RERUN_API_KEY}`,'Content-Type':'application/json'}}),signal)
 const reader=response.body?.getReader();if(!reader)throw new Error('Proposal acknowledgement unavailable')
 try{
  let size=0;const chunks:Uint8Array[]=[]
  for(;;){const part=await abortable(reader.read(),signal);if(part.done)break;if((size+=part.value.length)>4096)throw new Error('Acknowledgement exceeds limit');chunks.push(part.value)}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if(!response.ok || result.proposalId!==bundle.id)throw new Error('Proposal acknowledgement unavailable')
 }finally{void reader.cancel().catch(()=>{})}
}
