import type {LauncherInvocation,LauncherPorts} from './ports.js'
import type {DesktopComputerLauncherApp} from '@rerun/contracts'
import type {ScreenTarget} from '../isolated-screen/types.js'
import {LauncherRefusal} from './contract.js'
export type LauncherLiveAuthority={agentId:string;sessionId:string;runId:string;target:ScreenTarget;enabled:boolean;deleting:boolean;active:boolean;computer:boolean;terminalLaunch:boolean;filesLaunch:boolean}
export function createLauncherAuthority(read:(invocation:LauncherInvocation,signal:AbortSignal)=>Promise<LauncherLiveAuthority>):LauncherPorts['authorize']{
    return async(invocation,app:DesktopComputerLauncherApp,signal)=>{
        signal.throwIfAborted();const now=await read(invocation,signal);signal.throwIfAborted()
        if(!now.enabled||now.deleting||!now.active||now.agentId!==invocation.agentId||now.sessionId!==invocation.sessionId||now.runId!==invocation.runId||now.target.engineAgentId!==invocation.target.engineAgentId||now.target.launchNonce!==invocation.target.launchNonce||now.target.sessionGeneration!==invocation.target.sessionGeneration)throw new LauncherRefusal('interrupted','This coworker’s active screen run has changed.')
        if(!now.computer||(app==='terminal'?!now.terminalLaunch:!now.filesLaunch))throw new LauncherRefusal('permission-off','Enable computer control and this app’s separate launcher permission.')
    }
}
