import {it,expect} from 'vitest'
import {createComputerLaunchers} from './adapter.js'
import {createLauncherAuthority,type LauncherLiveAuthority} from './authority.js'
import {createLauncherAttemptStore,type LauncherTransaction} from './store.js'
import type {LauncherAttempt,LauncherInvocation,LauncherPorts} from './ports.js'
const target={engineAgentId:'engine-a',launchNonce:'11111111-1111-4111-8111-111111111111',sessionGeneration:'a'.repeat(32)}
const invocation:LauncherInvocation={agentId:'public-a',sessionId:'chat',runId:'run',requestId:'call-1',target}
function fixture(){
    const rows=new Map<string,LauncherAttempt>(),modes:string[]=[]
    let calls=0,published=0,stale=false,revoked=false,lost=false,oldFrame=false,takeover=false
    const transaction:LauncherTransaction=async(key,fn)=>{const {value,result}=fn(structuredClone(rows.get(key)??null));rows.set(key,structuredClone(value));return result}
    const current:LauncherLiveAuthority={...invocation,enabled:true,deleting:false,active:true,computer:true,terminalLaunch:true,filesLaunch:false}
    const authorize=createLauncherAuthority(async()=>({...current,terminalLaunch:!revoked&&current.terminalLaunch}))
    const ports:LauncherPorts={authorize,
        async withControl(_i,signal,work){
            if(takeover)throw new Error('human driving')
            return work({target,async check(){if(stale)throw new Error('stale')},
                async guest(body){modes.push(body.mode);if(body.mode==='launch')calls++;if(lost){lost=false;throw new Error('lost acknowledgement')}
                    return {ok:true,operationId:body.operationId,fingerprint:body.fingerprint,app:body.app,status:body.mode==='verify'&&oldFrame?'interrupted':'focused',windowId:'123'}},
                async capture(){return {image:Buffer.from('validated-jpeg'),mediaType:'image/jpeg',width:1280,height:720}},
            },signal)
        },
        async publish(){published++;return 'screenshot'},
    }
    const store=createLauncherAttemptStore(transaction)
    const runtime=createComputerLaunchers(ports,store)
    return {runtime,restart:()=>createComputerLaunchers(ports,store),current,modes,counts:()=>({calls,published}),set:(name:string)=>{if(name==='stale')stale=true;if(name==='revoke')revoked=true;if(name==='lost')lost=true;if(name==='oldFrame')oldFrame=true;if(name==='takeover')takeover=true}}
}
it('refuses URL/command/path/env fields before control or launch',async()=>{
    const f=fixture()
    for(const field of ['url','command','args','environment','path','executable'])await expect(f.runtime.open(invocation,{app:'terminal',[field]:'untrusted'},new AbortController().signal)).rejects.toThrow()
    expect(f.counts()).toEqual({calls:0,published:0})
})
it('keeps files and terminal grants independent from computer and native tools',async()=>{
    const f=fixture()
    await expect(f.runtime.open(invocation,{app:'files'},new AbortController().signal)).rejects.toThrow('separate launcher')
    f.current.computer=false
    await expect(f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)).rejects.toThrow('separate launcher')
    expect(f.counts().calls).toBe(0)
})
it('reconciles the same identity and never relaunches after a lost response',async()=>{
    const f=fixture();f.set('lost')
    await expect(f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)).rejects.toThrow('lost')
    const outcome=await f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)
    expect(f.modes).toEqual(['launch','reconcile','verify']);expect(f.counts().calls).toBe(1);expect(outcome.frame?.screenshotId).toBe('screenshot')
})
it('rejects changed identity under one durable request ID, including run and generation',async()=>{
    const f=fixture();await f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)
    f.current.runId='new-run'
    await expect(f.runtime.open({...invocation,runId:'new-run'},{app:'terminal'},new AbortController().signal)).rejects.toThrow('another operation')
    expect(f.counts().calls).toBe(1)
})
it.each(['stale','revoke','takeover','oldFrame'])('does not publish on %s',async reason=>{
    const f=fixture();f.set(reason)
    await expect(f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)).rejects.toThrow()
    expect(f.counts().published).toBe(0)
})
it.each(['enabled','active'] as const)('refuses when owner %s is false',async key=>{
    const f=fixture();f.current[key]=false
    await expect(f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)).rejects.toThrow('changed')
    expect(f.counts().calls).toBe(0)
})
it('does not acquire control after parent cancellation',async()=>{
    const f=fixture(),stop=new AbortController();stop.abort()
    await expect(f.runtime.open(invocation,{app:'terminal'},stop.signal)).rejects.toThrow()
    expect(f.counts().calls).toBe(0)
})
it('a durable store survives a factory restart and reconciles without launch',async()=>{
    const f=fixture()
    await f.runtime.open(invocation,{app:'terminal'},new AbortController().signal)
    await f.restart().open(invocation,{app:'terminal'},new AbortController().signal)
    expect(f.modes).toEqual(['launch','verify','reconcile','verify'])
    expect(f.counts().calls).toBe(1)
})
it('rejects a wrong coworker/target before any control effect',async()=>{
    const f=fixture()
    await expect(f.runtime.open({...invocation,target:{...target,engineAgentId:'other'}},{app:'terminal'},new AbortController().signal)).rejects.toThrow('changed')
    expect(f.counts()).toEqual({calls:0,published:0})
})
