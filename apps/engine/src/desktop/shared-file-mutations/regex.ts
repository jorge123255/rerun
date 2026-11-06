import { Worker } from 'node:worker_threads'

/** Keep pathological regex work off the thread that handles Stop and authority changes. */
export async function sharedRegexLines(lines: string[], pattern: string, max: number, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted()
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.once('message',({lines,pattern,max})=>{try{const r=new RegExp(pattern),found=[];for(let i=0;i<lines.length&&found.length<max;i++){if(lines[i].length>4000)continue;r.lastIndex=0;if(r.test(lines[i]))found.push(i)}parentPort.postMessage({found})}catch{parentPort.postMessage({error:true})}})`, { eval: true })
    try {
        return await new Promise<number[]>((resolve, reject) => {
            let settled = false
            const stop = () => finish(signal?.reason ?? new Error('Shared search cancelled'))
            const finish = (error?: unknown, found?: number[]) => {
                if (settled) return
                settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop)
                if (error) reject(error); else resolve(found ?? [])
            }
            const timer = setTimeout(() => finish(new Error('Shared search pattern exceeded its time limit.')), 250)
            signal?.addEventListener('abort', stop, { once: true })
            worker.once('error', error => finish(error))
            worker.once('message', value => value.error ? finish(new Error('Invalid shared search pattern.')) : finish(undefined, value.found))
            worker.postMessage({ lines, pattern, max })
            if (signal?.aborted) stop()
        })
    } finally { await worker.terminate() }
}
