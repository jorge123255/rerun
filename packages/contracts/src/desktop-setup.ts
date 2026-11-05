import { z } from 'zod'

export const desktopSetupRequiredSchema = z.boolean().nullable()

export const desktopSetupViewSchema = z.object({
    agentId: z.string(),
    revision: z.string().min(1),
    required: desktopSetupRequiredSchema,
    prompt: z.string(),
    completedAt: z.string().nullable(),
    sessionId: z.string().nullable(),
    pending: z.boolean(),
    skipped: z.boolean(),
    defaultPrompt: z.string(),
})
export type DesktopSetupView = z.infer<typeof desktopSetupViewSchema>

export const desktopSetupSaveInputSchema = z.strictObject({
    requestId: z.uuid(),
    expectedRevision: z.string().min(1),
    required: desktopSetupRequiredSchema,
    prompt: z.string().max(100_000),
})
export const desktopSetupActionInputSchema = z.strictObject({
    requestId: z.uuid(),
    expectedRevision: z.string().min(1),
})
export const desktopSetupPostSchema = z.discriminatedUnion('action', [
    desktopSetupSaveInputSchema.extend({ action: z.literal('save') }),
    desktopSetupActionInputSchema.extend({ action: z.literal('start') }),
    desktopSetupActionInputSchema.extend({ action: z.literal('continue') }),
    desktopSetupActionInputSchema.extend({ action: z.literal('skip') }),
])
export type DesktopSetupPost = z.infer<typeof desktopSetupPostSchema>

export const desktopSetupMutationResultSchema = z.object({
    view: desktopSetupViewSchema,
    sessionId: z.string().nullable().optional(),
})
export type DesktopSetupMutationResult = z.infer<typeof desktopSetupMutationResultSchema>

export const DESKTOP_SETUP_DEFAULT_PROMPT = `Introduce yourself in two lines, then show one concrete result of your job built only from tools this Mac coworker actually has: files in your workspace, web search, the browser, your database, scheduled tasks and connected apps. Verify what you show works before presenting it. Ask for anything missing with the question tool instead of guessing. Never promise environment variables, shell secrets, logins or apps that are not connected. When everything asked for is genuinely in place and verified, call install_complete so the user gets a normal message box back.`
