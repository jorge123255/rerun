import { z } from 'zod'
import { desktopServiceHealthSchema, SERVICE_INSTANCE_ID_RE } from '@rerun/contracts'

const name = z.string().trim().min(1).max(120)
const variable = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const value = z.string().min(1).max(16384).refine(secret => secret !== '•••')
const serverName = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const desktopVaultProgramVariable = variable.refine(key =>
    !/^(?:HOME|PATH|TMPDIR|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DYLD_.*|LD_.*|BASH_ENV|ENV|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|GCONV_PATH|RERUN_.*)$/i.test(key),
    'This variable is reserved by the program launcher.')
export const desktopVaultProgramValue = z.string().min(1).max(8192).refine(secret => !/[\0\r\n]/.test(secret) && secret !== '•••')
export const desktopVaultProgramCredentialLimit = 16
const executable = z.string().min(1).max(4096).refine(path => path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path))
const args = z.array(z.string().max(4096).refine(arg => !/[\x00-\x1f\x7f]/.test(arg) && !arg.includes('${'))).max(64)
const serverUrl = z.url({ protocol: /^https$/ }).max(2048)
const bearer = z.string().max(8192).regex(/^[!-~]*$/)
const reservedHeaders = /^(?:(?:host|cookie|cookie2|set-cookie|connection|upgrade|te|trailer|transfer-encoding|keep-alive|expect|via|forwarded|origin|referer|user-agent|accept|accept-encoding|content-type|content-length|content-encoding|range|alt-used)$|proxy-|sec-|mcp-|x-rerun-|x-forwarded-|x-original-|x-rewrite-|x-real-ip$|x-http-method)/
const credentialHeaderName = z.string().trim().toLowerCase().regex(/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/)
    .refine(header => !reservedHeaders.test(header), 'This header is reserved by the connection.')
const credentialHeader = z.strictObject({
    name: credentialHeaderName,
    value: z.string().min(1).max(8192).regex(/^[ -~]+$/).refine(value => value.trim() === value),
})
const appLabel = name.refine(label => !/[\u0000-\u001f\u007f]/.test(label))
const appSlug = z.string().regex(/^[a-z0-9-]{1,128}$/)
const methodId = z.string().min(1).max(128)
const appValues = z.record(z.string().regex(/^[A-Za-z0-9_]{1,128}$/), z.string().max(8192))
const target = { id: z.uuid(), revision: z.uuid() }
export const desktopVaultHealthTarget = z.strictObject(target)
export const desktopVaultHealthReceipt = desktopServiceHealthSchema.extend({ state: z.enum(['healthy', 'error', 'disconnected']), checkedAt: z.iso.datetime(), credentialExpiresAt: z.iso.datetime().optional() })
export type DesktopVaultHealthReceipt = z.infer<typeof desktopVaultHealthReceipt>
const sharing = { agentIds: z.array(z.uuid()).max(250), sharedWithAll: z.boolean() }

export const desktopVaultMutation = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('create'), name, variable, value }),
    z.strictObject({ operation: z.literal('create-program'), name: serverName, executable, args }),
    z.strictObject({ operation: z.literal('replace-program'), ...target, executable, args }),
    z.strictObject({ operation: z.literal('set-program-credential'), ...target, variable: desktopVaultProgramVariable, value: desktopVaultProgramValue }),
    z.strictObject({ operation: z.literal('remove-program-credential'), ...target, variable: desktopVaultProgramVariable }),
    z.strictObject({ operation: z.literal('add-app'), slug: appSlug, methodId, values: appValues, label: appLabel.optional(), expectedAccounts: z.number().int().min(0).optional() }),
    z.strictObject({ operation: z.literal('rename-app'), ...target, label: appLabel }),
    z.strictObject({ operation: z.literal('configure-app'), ...target, methodId, values: appValues }),
    z.strictObject({ operation: z.literal('create-server'), name: serverName, url: serverUrl, bearer, browserSignIn: z.literal(true).optional(), header: credentialHeader.optional() }).refine(input => Number(!!input.bearer) + Number(!!input.header) + Number(!!input.browserSignIn) <= 1),
    z.strictObject({ operation: z.literal('enable-server-oauth'), ...target }),
    z.strictObject({ operation: z.literal('clear-server-oauth'), ...target }),
    z.strictObject({ operation: z.literal('replace-server-bearer'), ...target, bearer }),
    z.strictObject({ operation: z.literal('replace-server-header'), ...target, header: credentialHeader }),
    z.strictObject({ operation: z.literal('replace'), ...target, value }),
    z.strictObject({ operation: z.literal('share'), ...target, ...sharing }),
    z.strictObject({ operation: z.literal('delete'), ...target }),
])

export type DesktopVaultMutation = z.infer<typeof desktopVaultMutation>

const secretEntry = z.strictObject({ ...target, name, variable, ...sharing })
const mcpEntry = z.strictObject({ ...target, name: serverName, kind: z.literal('mcp'), url: serverUrl, hasBearer: z.boolean(), catalog: z.strictObject({ slug: appSlug, methodId, name, instanceId: z.string().regex(SERVICE_INSTANCE_ID_RE).optional(), label: appLabel.optional(), health: desktopVaultHealthReceipt.optional() }).optional(), browserSignIn: z.literal(true).optional(), signedOut: z.literal(true).optional(), headerName: credentialHeaderName.optional(), ...sharing })
const programEntry = z.strictObject({ ...target, name: serverName, kind: z.literal('program'), executable, args, credentialNames: z.array(desktopVaultProgramVariable).max(desktopVaultProgramCredentialLimit), ...sharing })
export const desktopVaultEntry = z.union([secretEntry, mcpEntry, programEntry])
export const desktopVaultListing = z.strictObject({
    entries: z.array(desktopVaultEntry),
    coworkers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
})

export type DesktopVaultListing = z.infer<typeof desktopVaultListing>
export type DesktopVaultEntry = z.infer<typeof desktopVaultEntry>

export const desktopCoworkerVaultMutation = z.strictObject({ ...target, attached: z.boolean() })
export type DesktopCoworkerVaultMutation = z.infer<typeof desktopCoworkerVaultMutation>

const coworkerVaultEntry = z.union([secretEntry.omit({ agentIds: true }), mcpEntry.omit({ agentIds: true }), programEntry.omit({ agentIds: true, args: true, credentialNames: true })])
export type DesktopCoworkerVaultEntry = z.infer<typeof coworkerVaultEntry>
export const desktopCoworkerVaultListing = z.strictObject({
    agentId: z.uuid(),
    attached: z.array(coworkerVaultEntry),
    available: z.array(coworkerVaultEntry),
})
export type DesktopCoworkerVaultListing = z.infer<typeof desktopCoworkerVaultListing>
