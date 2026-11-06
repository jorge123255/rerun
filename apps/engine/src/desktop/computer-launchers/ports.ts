import type {ScreenTarget,ScreenShot} from '../isolated-screen/types.js'
import type {DesktopComputerLauncherOperation as Operation,DesktopComputerLauncherApp as App,DesktopComputerLauncherOutcome as Outcome} from '@rerun/contracts'
export type LauncherInvocation={agentId:string;sessionId:string;runId:string;requestId:string;target:ScreenTarget}
export type LauncherAttempt={version:1;operation:Operation;fingerprint:string;operationId:string;phase:'reserved'|'submitted'|'settled';outcome:Outcome|null}
export interface LauncherAttemptStore {
    // Atomic identity reservation, durable before returning. Same requestId is globally unique.
    reserve(attempt:LauncherAttempt):Promise<{created:boolean;attempt:LauncherAttempt}>;
    submitted(attempt:LauncherAttempt):Promise<void>;
    settle(attempt:LauncherAttempt,outcome:Outcome):Promise<void>;
}
export type LauncherControl={
    target:ScreenTarget;
    check(signal:AbortSignal):Promise<void>;
    guest(body:{op:'computer-launcher';operationId:string;fingerprint:string;app:App;mode:'launch'|'reconcile'|'verify'},signal:AbortSignal):Promise<unknown>;
    capture(signal:AbortSignal):Promise<ScreenShot>;
}
export interface LauncherPorts {
    // Live public -> engine mapping, current run, enabled/not deleting, computer + exact app grant.
    authorize(invocation:LauncherInvocation,app:App,signal:AbortSignal):Promise<void>;
    // Existing screenOwners/action budget, generation lock, takeover and cancellation ACK boundary.
    withControl<T>(invocation:LauncherInvocation,signal:AbortSignal,work:(control:LauncherControl,signal:AbortSignal)=>Promise<T>):Promise<T>;
    // Existing validated screenshot store; callback must check authority at publication.
    publish(invocation:LauncherInvocation,frame:ScreenShot,signal:AbortSignal):Promise<string>;
}
