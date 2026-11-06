import {z} from 'zod'
import {desktopServiceAccountIntentSchema} from './desktop-service-accounts.js'
export const desktopServiceOAuthStateSchema=z.enum(['configured','starting','waiting','checking','connected','cancelled','expired','error','unsupported','interrupted','disconnected'])
export const desktopServiceOAuthSnapshotSchema=z.object({
 attemptId:z.string().uuid(),revision:z.string().uuid(),coworkerId:z.string(),installationId:z.string().uuid(),accountKey:z.string(),label:z.string(),methodId:z.string(),configGeneration:z.string().uuid(),
 authorizationUrl:z.string().url().max(8192).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')}).optional(),
 state:desktopServiceOAuthStateSchema,expiresAt:z.number(),configured:z.boolean(),installed:z.boolean(),message:z.string(),
}).strict()
export type DesktopServiceOAuthSnapshot=z.infer<typeof desktopServiceOAuthSnapshotSchema>
export const desktopServiceOAuthActionSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('configure'),requestId:z.string().uuid(),intent:desktopServiceAccountIntentSchema,slug:z.string().min(1).max(200),methodId:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('current'),accountKey:z.string().min(1).max(220)}).strict(),
 z.object({action:z.literal('lookup'),requestId:z.string().uuid()}).strict(),
 z.object({action:z.literal('start'),requestId:z.string().uuid(),accountKey:z.string().min(1).max(220),expectedGeneration:z.string().uuid()}).strict(),
 z.object({action:z.enum(['status','cancel','probe','disconnect']),attemptId:z.string().uuid(),expectedRevision:z.string().uuid()}).strict(),
])
export type DesktopServiceOAuthAction=z.infer<typeof desktopServiceOAuthActionSchema>
export type DesktopServiceOAuthState=z.infer<typeof desktopServiceOAuthStateSchema>
