import type { SubRunTask } from './chat-sub-runs.js'

export type DesktopDelegationTask = Omit<SubRunTask, 'id' | 'toolCalls' | 'failures' | 'calls' | 'preview'> & {
    taskId: string; toolCalls: number; failures: number; preview: string;
    calls: NonNullable<SubRunTask['calls']>; result?: string; partial?: boolean;
    cleanup: 'pending' | 'complete' | 'blocked';
}
export type DesktopDelegationSnapshot = {
    delegationId: string; revision: string; parentAgentId: string;
    parentSessionId: string; parentRunId: string; toolCallId: string;
    tasks: DesktopDelegationTask[];
}
export type DesktopDelegationInput = { tasks: { title?: string; task: string; context?: string }[] }
export type DesktopDelegationStop = {
    operation: 'stop-task'; requestId: string; delegationId: string;
    taskId: string; expectedRevision: string;
}
