import 'server-only'

/** One instance per store/runtime binding. Reservations and invalidation happen before any await. */
export function remoteMcpLifecycle() {
    type State = { generation:number; pending:number; tail:Promise<unknown>; active:Set<AbortController> }
    let closed=false
    const states = new Map<string,State>()
    const state = (agent:string,name:string) => {
        const key = JSON.stringify([agent,name])
        let value=states.get(key)
        if (!value) {value={generation:0,pending:0,tail:Promise.resolve(),active:new Set()};states.set(key,value)}
        return value
    }
    function invalidate(value:State) {
        value.generation++
        for (const controller of value.active) controller.abort()
    }
    function admit(agent:string,name:string,controller:AbortController) {
        const owner=state(agent,''), server=state(agent,name)
        if (closed || owner.pending || server.pending) throw new Error('MCP configuration is changing')
        const generation=server.generation, ownerGeneration=owner.generation
        server.active.add(controller); owner.active.add(controller)
        return {
            assertCurrent() {
                controller.signal.throwIfAborted()
                if (closed || owner.pending || server.pending || generation!==server.generation || ownerGeneration!==owner.generation) throw new Error('MCP capability invalidated')
            },
            release() {server.active.delete(controller);owner.active.delete(controller)},
        }
    }
    function disconnect(agent:string,name?:string) {invalidate(state(agent,name ?? ''))}
    function mutate<T>(agent:string,name:string,write:()=>Promise<T>):Promise<T> {
        if(closed)return Promise.reject(new Error('MCP is stopped'))
        const value=state(agent,name)
        value.pending++; invalidate(value)
        const result=value.tail.catch(()=>{}).then(()=>{
            if(closed)throw new Error('MCP is stopped')
            return write()
        })
        value.tail=result
        return result.finally(()=>{value.pending--;invalidate(value)})
    }
    function watch(agent:string,name:string) {
        const owner=state(agent,''), server=state(agent,name)
        const a=owner.generation,b=server.generation
        return () => {
            if(closed || owner.pending || server.pending || owner.generation!==a || server.generation!==b) throw new Error('MCP capability invalidated')
        }
    }
    function commitCredentials<T>(agent:string,name:string,signal:AbortSignal,write:(check:()=>void)=>Promise<T>):Promise<T> {
        const server=state(agent,name),owner=state(agent,''),a=server.generation,b=owner.generation
        const check=()=>{signal.throwIfAborted();if(closed || owner.pending || a!==server.generation || b!==owner.generation)throw new Error('MCP credential admission invalidated')}
        check();server.pending++
        const result=server.tail.catch(()=>{}).then(()=>{check();return write(check)})
        server.tail=result
        return result.finally(()=>{server.pending--})
    }
    return {admit,disconnect,mutate,watch,commitCredentials,
        transitionOwner:<T>(agent:string,write:()=>Promise<T>)=>mutate(agent,'',write),
        shutdown:()=>{closed=true;for(const value of states.values())invalidate(value)},
    }
}
