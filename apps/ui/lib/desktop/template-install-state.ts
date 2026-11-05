import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateInstallResultSchema, desktopTemplateRequestIdSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'

export const desktopTemplateInstallIdentitySchema = z.strictObject({
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
})

export const desktopTemplateInstallStateSchema = z.union([
    desktopTemplateInstallIdentitySchema.extend({ status: z.literal('none') }),
    desktopTemplateInstallIdentitySchema.extend({ status: z.enum(['pending', 'refused']), requestId: desktopTemplateRequestIdSchema }),
    desktopTemplateInstallResultSchema.options[0],
])

export type DesktopTemplateInstallState = z.infer<typeof desktopTemplateInstallStateSchema>
