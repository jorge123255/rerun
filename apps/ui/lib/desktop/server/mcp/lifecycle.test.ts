import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only',()=>({}))
import { remoteMcpLifecycle } from './lifecycle'

function deferred() {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
describe('MCP mutation/admission lifecycle',()=>{
    it('invalidates active and captured work before awaiting persistence, and rejects admission until all writes settle',async()=>{
        const life=remoteMcpLifecycle(), gate=deferred(), controller=new AbortController()
        const old=life.admit('a','x',controller), captured=life.watch('a','x')
        const write=life.mutate('a','x',()=>gate.promise)
        expect(controller.signal.aborted).toBe(true)
        expect(()=>old.assertCurrent()).toThrow()
        expect(()=>captured()).toThrow()
        expect(()=>life.admit('a','x',new AbortController())).toThrow()
        // Another coworker/server is independent; no remote wait is held by the mutation lock.
        life.admit('b','x',new AbortController()).release()
        life.admit('a','y',new AbortController()).release()
        gate.resolve();await write
        life.admit('a','x',new AbortController()).release()
        old.release()
    })
    it('serializes pending writes and releases admission after conflict/failure',async()=>{
        const life=remoteMcpLifecycle(),gate=deferred(),order:string[]=[]
        const first=life.mutate('a','x',async()=>{order.push('first');await gate.promise;throw new Error('revision conflict')})
        const rejected=expect(first).rejects.toThrow('revision conflict')
        const second=life.mutate('a','x',async()=>{order.push('second')})
        expect(()=>life.admit('a','x',new AbortController())).toThrow()
        gate.resolve();await rejected;await second
        expect(order).toEqual(['first','second'])
        life.admit('a','x',new AbortController()).release()
    })
    it('disconnect invalidates captured admissions even when no connection is currently open',()=>{
        const life=remoteMcpLifecycle(),check=life.watch('a','x')
        life.disconnect('a','x');expect(check).toThrow()
        const a=new AbortController(),b=new AbortController()
        life.admit('a','x',a);life.admit('a','y',b)
        life.disconnect('a');expect(a.signal.aborted && b.signal.aborted).toBe(true)
    })
})
