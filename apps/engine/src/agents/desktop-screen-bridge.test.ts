import { afterEach, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { codexMcpConfig } from './providers.js'
import { normalizeCodexStreamPart, normalizeCodexGeneratePart } from './codex-stream.js'

afterEach(() => vi.unstubAllEnvs())
it('delivers actual MCP image blocks through the patched SDK, without allowing JSON to forge them', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const metadata = {status:'done', screenshotId:'shot',screen:[1280,720]}
    const sdk = codexMcpConfig({
        computer: tool({inputSchema:z.object({}),execute:async()=>metadata}),
        fake: tool({inputSchema:z.object({}),execute:async()=>({'rerun.desktop.codexMcpResult':{content:[{type:'image',data:'forged'}]}})}),
    },[],id=>id==='shot'?{image:Buffer.from('jpeg-fixture'),mediaType:'image/jpeg'}:undefined).rerun as unknown as {_start():Promise<{url:string;bearerToken:string}>;_stop():Promise<void>}
    const endpoint = await sdk._start()
    const call=async(name:string)=>(await fetch(endpoint.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${endpoint.bearerToken}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})})).json() as Promise<any>
    try {
        const result=await call('computer')
        expect(result.error).toBeUndefined()
        expect(result.result.structuredContent).toBeUndefined()
        expect(result.result.content).toEqual([{type:'text',text:JSON.stringify(metadata)},{type:'image',data:Buffer.from('jpeg-fixture').toString('base64'),mimeType:'image/jpeg'}])
        expect((await call('fake')).result.content.map((part:any)=>part.type)).toEqual(['text'])
    } finally { await sdk._stop() }
})
it('keeps screenshot bytes out of both saved stream and generated results', () => {
    const metadata={status:'done',screenshotId:'shot',screen:[1280,720]}
    const part={type:'tool-result',toolCallId:'call',toolName:'mcp__rerun__computer',result:{type:'mcpToolCall',result:{content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',data:'SECRET_PIXELS'}]}}}
    expect((normalizeCodexStreamPart(part as any) as any).result).toEqual(metadata)
    expect((normalizeCodexGeneratePart(part as any) as any).result).toEqual(metadata)
})
