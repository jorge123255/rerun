import type {LauncherAttempt,LauncherAttemptStore} from './ports.js'
// Implement this transaction in the existing durable screen operation authority.
export type LauncherTransaction=<T>(key:string,work:(current:LauncherAttempt|null)=>{value:LauncherAttempt;result:T})=>Promise<T>
export function createLauncherAttemptStore(transaction:LauncherTransaction):LauncherAttemptStore{
    const key=(attempt:LauncherAttempt)=>`computer-launcher:${attempt.operation.requestId}`
    const matching=(current:LauncherAttempt|null,attempt:LauncherAttempt)=>{
        if(!current||current.version!==1||current.fingerprint!==attempt.fingerprint||current.operationId!==attempt.operationId)throw new Error('Launcher attempt identity conflict')
        return current
    }
    return {
        reserve:attempt=>transaction(key(attempt),current=>{if(current&&current.version!==1)throw new Error('Unsupported launcher record');return {value:current??attempt,result:{created:current===null,attempt:current??attempt}}}),
        submitted:attempt=>transaction(key(attempt),current=>{const record=matching(current,attempt);return {value:record.phase==='reserved'?{...record,phase:'submitted'}:record,result:undefined}}),
        settle:(attempt,outcome)=>transaction(key(attempt),current=>{const record=matching(current,attempt);return {value:{...record,phase:'settled',outcome},result:undefined}}),
    }
}
