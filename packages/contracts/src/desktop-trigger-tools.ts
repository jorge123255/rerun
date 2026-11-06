import { z } from 'zod'

/** Existing Triggers grant. Root adds `trigger_edit` to that catalog row. This is not `scheduleManage`. */
export const DESKTOP_TRIGGER_TOOL_GRANT_ID = 'trigger' as const

export const DESKTOP_TRIGGER_TOOL_NAMES = ['trigger_list', 'trigger_create', 'trigger_get', 'trigger_edit', 'trigger_update', 'trigger_rotate_token', 'trigger_delete'] as const
export type DesktopTriggerToolName = (typeof DESKTOP_TRIGGER_TOOL_NAMES)[number]

/** Instruction cap already enforced by the desktop trigger create and update schemas. Inbound delivery caps stay on the dispatch path. */
export const DESKTOP_TRIGGER_TOOL_MAX_BODY_CHARS = 64000

export const desktopTriggerToolOutcomeSchema = z.enum(['committed', 'rejected', 'cancelled', 'uncertain'])
export type DesktopTriggerToolOutcome = z.infer<typeof desktopTriggerToolOutcomeSchema>

export const desktopTriggerToolOperationSchema = z.enum(['list', 'get', 'create', 'update', 'edit', 'rotate', 'delete'])
export type DesktopTriggerToolOperation = z.infer<typeof desktopTriggerToolOperationSchema>

export const desktopTriggerRotateConfirmationSchema = z.object({
    slug: z.string().min(1).max(64),
    revision: z.string().min(1).max(128),
    action: z.literal('rotate'),
}).strict()
export type DesktopTriggerRotateConfirmation = z.infer<typeof desktopTriggerRotateConfirmationSchema>

export const DESKTOP_TRIGGER_TOOL_MESSAGES = {
    unwired: 'Webhook management is not wired on this Mac yet.',
    permission: 'Triggers are turned off for this coworker.',
    disabled: 'Enable this coworker to manage triggers.',
    deleting: 'Coworker identity changed',
    setup: 'Finish guided setup before managing triggers.',
    inactive: 'Trigger run is no longer active.',
    invocation: 'Trigger mutation requires a trusted tool invocation.',
    fileUnsafe: 'Trigger file could not be read.',
    cancelled: 'Trigger change cancelled.',
    uncertain: 'Trigger change was not acknowledged. Retry the same change.',
    stale: 'Trigger changed since you read it. Call trigger_get and retry. The previous trigger was kept.',
    conflict: 'This request belongs to a different trigger change',
    interrupted: 'This earlier change was interrupted. Reopen the trigger and make a new change.',
    pending: 'Another trigger change is awaiting acknowledgement. Retry that change first.',
    replaced: 'Trigger was replaced while its change was pending',
    exists: 'A trigger with this name already exists. Use trigger_update or trigger_edit.',
    revoked: 'Triggers were revoked for this coworker.',
    providerWithoutModel: 'provider only goes with a model; nothing changed.',
    identical: 'oldString and newString are identical; nothing to do.',
    emptyExcerpt: 'oldString must be a non-empty excerpt.',
    name: 'Trigger name must contain a letter or digit.',
    nameLength: 'Trigger name must be 1 to 120 characters.',
    descriptionLength: 'Description is too long.',
    tooLong: 'Task instruction is too long.',
    emptyBody: 'Task instruction is empty.',
    methods: 'Accepted methods must be GET, POST, PUT, PATCH, or DELETE.',
    rejectedInput: 'Trigger input was rejected. Nothing was saved.',
    empty: 'No webhook triggers yet.',
    localOnly: 'This webhook is local to this Mac while Rerun is open. There is no public URL.',
    rotateConfirm: 'Token rotation needs a confirmation for this trigger, its current revision, and the action rotate. A chat approval is not enough. The previous address still works.',
    notFound: (slug: string) => `Trigger not found: ${slug}`,
    noModel: (model: string) => `This coworker has no connected model to compare with ${model}, so nothing was saved.`,
    pinRefused: (current: string) => `Desktop triggers follow this coworker's connected model (${current}). A named pin is resolved again when the webhook fires, so nothing was saved.`,
    missingExcerpt: (slug: string) => `oldString not found in ${slug}. Call trigger_get to read the current body, then retry with an exact excerpt of it. Never fall back to rewriting the whole body from memory.`,
    ambiguous: (slug: string, count: number) => `oldString matches ${count} times in ${slug}; pass replaceAll or provide a more specific string.`,
    created: (slug: string, methods: string) => `Created trigger ${slug} (${methods}). This webhook is local to this Mac while Rerun is open. There is no public URL. Copy the address from the Triggers tab. Tools do not receive the secret.`,
    updated: (slug: string) => `Updated trigger ${slug}`,
    replacedBody: (slug: string, before: number, after: number) => `Updated trigger ${slug} (body replaced: ${before} → ${after} chars)`,
    edited: (slug: string, count: number) => `Edited trigger ${slug} (${count} replacement${count === 1 ? '' : 's'})`,
    deleted: (slug: string) => `Deleted trigger ${slug}`,
    rotated: (slug: string) => `Rotated the secret of ${slug}. The previous local address for this trigger no longer works. Other triggers are unchanged. There is no public URL.`,
} as const

export const DESKTOP_TRIGGER_TOOL_DESCRIPTIONS = {
    trigger_list: 'List your webhook triggers. Each one is a local webhook that can start a run while Rerun is open on this Mac. There is no public URL. Instruction bodies are not included here; read one in full with trigger_get. Listing does not deliver an event.',
    trigger_create: 'Create a webhook trigger that can start a run while Rerun is open on this Mac. There is no public URL. The body is the instruction you will execute, and the caller payload is attached to it. Tell the user to copy the local address from the Triggers tab. Tools do not receive the secret. HTTP methods default to POST. Adding GET means any link preview can fire it. Creating does not deliver an event.',
    trigger_get: 'Read one webhook trigger in full, including its instruction body and its definition revision. There is no public URL and the secret is not included. Use this before changing a body so you edit what is actually there instead of rewriting it from memory. Reading does not deliver an event.',
    trigger_edit: 'Make a surgical edit to a webhook trigger body by replacing an exact string — this is the default way to change a body and it preserves everything else. Read the body with trigger_get first so oldString is an exact excerpt. Prefer this over trigger_update for any partial change. By default oldString must match exactly once. Pass expectedRevision from trigger_get. This does not deliver an event.',
    trigger_update: 'Update a webhook trigger: its description, instruction body, accepted HTTP methods, model, or enable/disable it. The name and local address cannot change. Passing body overwrites the entire instruction body, discarding all of its existing content: use it ONLY for a deliberate full rewrite of a body you have just read with trigger_get, never for one you reconstructed from memory. For ANY partial change to the body, use trigger_edit instead. Adding GET means any link preview can fire it. Pass expectedRevision from trigger_get. This does not deliver an event.',
    trigger_rotate_token: 'Rotate a webhook trigger secret, which changes its local address. Every caller already using the old address stops working, so confirm with the user first. Pass confirmation { slug, revision, action: "rotate" } copied from trigger_get. A chat approval is not enough. The previous address stays valid until this change is committed. There is no public URL. Tools do not receive the new secret.',
    trigger_delete: 'Delete a webhook trigger. Its local address stops accepting new calls. Recorded deliveries are kept. This does not replay events. There is no public URL.',
} as const

/** Desktop replacement for the hosted trigger index. Do not tell the model it has a public URL. */
export const DESKTOP_TRIGGER_TOOL_PROMPT = 'Webhook triggers on this Mac are local while Rerun is open. There is no public URL. Do not invent a host, tunnel, or secret. Use trigger_get before trigger_edit or trigger_update. trigger_edit replaces an exact excerpt; trigger_update replaces the whole body. trigger_rotate_token requires confirmation { slug, revision, action: "rotate" } from trigger_get. A chat approval does not rotate the secret. Tools never receive the secret. Copy the address from the Triggers tab.'

export const desktopTriggerToolProjectionSchema = z.object({
    outcome: desktopTriggerToolOutcomeSchema,
    operation: desktopTriggerToolOperationSchema,
    text: z.string(),
    slug: z.string().nullable(),
    revision: z.string().nullable(),
}).strict()
export type DesktopTriggerToolProjection = z.infer<typeof desktopTriggerToolProjectionSchema>
