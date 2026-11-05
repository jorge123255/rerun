import {z} from 'zod'
export const launcherRequestSchema=z.object({app:z.enum(['terminal','files'])}).strict()
export const launcherOperationSchema=z.object({requestId:z.string().min(1).max(200),agentId:z.string().min(1).max(128),sessionId:z.string().min(1).max(128),runId:z.string().min(1).max(128),generation:z.string().regex(/^[a-f0-9]{32}$/),app:z.enum(['terminal','files'])}).strict()
export const guestLauncherReplySchema=z.object({ok:z.literal(true),operationId:z.string().regex(/^[a-f0-9]{64}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),app:z.enum(['terminal','files']),status:z.enum(['opened','focused','interrupted','app-missing','timeout']),windowId:z.string().regex(/^[1-9][0-9]{0,15}$/).nullable()}).strict()
export class LauncherRefusal extends Error {
    constructor(public readonly state: import('../../../../../packages/contracts/src/desktop-computer-launchers.js').DesktopComputerLauncherState, message:string){super(message)}
}
