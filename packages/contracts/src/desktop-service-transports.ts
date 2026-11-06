import { z } from 'zod'
import { authMethodSummarySchema, desktopInstalledServiceSchema, isServiceRegistryKey, parseServiceRegistryKey } from './desktop-services.js'
import { desktopMcpSseToolSchema } from './desktop-mcp-sse.js'
import type { DesktopServiceAccountView } from './desktop-service-accounts.js'

export const SERVICE_TRANSPORT_LIMITS = Object.freeze({ inputs: 64, inputBytes: 8192, templateBytes: 32768, args: 64, env: 64, servers: 1, tools: 256, catalogBytes: 1048576, resultBytes: 1048576, argumentBytes: 65536, operationMs: 120000, closeMs: 5000 })
const id = z.string().min(1).max(200).refine(v => !/[\p{Cc}]/u.test(v))
// This projection addresses F's installation, rather than defining another account model.
export type ServiceTransportAccount = Pick<DesktopServiceAccountView, 'key' | 'installationId' | 'revision'>
export const serviceTransportRefSchema = desktopInstalledServiceSchema.pick({ key: true, revision: true }).extend({
    key: z.string().min(1).max(220).refine(key => key.includes('@') ? isServiceRegistryKey(key) && /^[a-z0-9][a-z0-9-]*$/.test(parseServiceRegistryKey(key).slug) : /^[a-z0-9][a-z0-9-]*$/.test(key)), revision: z.string().uuid(), installationId: z.string().uuid(), agentId: id,
}).strict()
export type ServiceTransportRef = z.infer<typeof serviceTransportRefSchema>
export const serviceTransportControlSchema = serviceTransportRefSchema.extend({
    requestId: z.string().uuid(), action: z.enum(['status', 'probe', 'reconnect', 'disconnect', 'stop']),
}).strict()
export type ServiceTransportControl = z.infer<typeof serviceTransportControlSchema>
export const serviceTransportReceiptSchema = z.strictObject({
    ref: serviceTransportRefSchema, requestId: z.string().uuid(), action: z.enum(['probe', 'reconnect', 'disconnect', 'stop', 'call']),
    outcome: z.enum(['completed', 'refused', 'uncertain']), state: z.enum(['unchecked', 'healthy', 'unavailable', 'disconnected', 'closing', 'uncertain']),
    failure: z.enum(['unavailable', 'unsupported', 'auth-needed', 'changed', 'grant', 'invalid', 'cancelled', 'unknown', 'close-unconfirmed']).optional(),
})
export type ServiceTransportReceipt = z.infer<typeof serviceTransportReceiptSchema>
export const serviceTransportSnapshotSchema = z.strictObject({
    ref: serviceTransportRefSchema, transport: z.enum(['sse', 'stdio']), methodId: id,
    state: z.enum(['unchecked', 'healthy', 'unavailable', 'disconnected', 'closing', 'uncertain']),
    failure: serviceTransportReceiptSchema.shape.failure, tools: z.array(desktopMcpSseToolSchema).max(SERVICE_TRANSPORT_LIMITS.tools),
    observation: z.enum(['saved', 'live', 'probe']), receipt: serviceTransportReceiptSchema.optional(),
})
export type ServiceTransportSnapshot = z.infer<typeof serviceTransportSnapshotSchema>
export const serviceTransportMethodSchema = authMethodSummarySchema.extend({
    transport: z.enum(['sse', 'stdio']).optional(), availability: z.enum(['supported', 'dependent', 'unsupported']), reason: z.enum(['ready', 'program', 'environment', 'secret-argv', 'oauth', 'headers', 'hosted', 'shape', 'other-transport']),
}).strict()
export type ServiceTransportMethod = z.infer<typeof serviceTransportMethodSchema>
export const serviceTransportSetupIntentSchema = z.strictObject({ ref: serviceTransportRefSchema, requestId: z.string().uuid(), methodId: id })
export type ServiceTransportSetupIntent = z.infer<typeof serviceTransportSetupIntentSchema>
export const SERVICE_TRANSPORT_COPY = {
    unavailable: 'Connection unavailable. Check setup and current permission.', unsupported: 'This method is not available locally.',
    'auth-needed': 'Complete this account’s sign-in or credential setup in Apps.', changed: 'This account or configuration changed. Refresh before continuing.',
    grant: 'Enable the required Apps and transport permissions for this coworker.', invalid: 'The service returned invalid or oversized data.',
    cancelled: 'Operation stopped. A remote tool may have already run; do not automatically repeat it.',
    unknown: 'Acknowledgement is unavailable. Inspect the app before explicitly requesting another operation.',
    'close-unconfirmed': 'Connection or process exit is not confirmed. Retry Stop before reconnecting.',
} as const
