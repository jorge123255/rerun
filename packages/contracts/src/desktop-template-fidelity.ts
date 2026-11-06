import { z } from 'zod'
import { desktopPortableMemberSchema, desktopPortableCoworkerSchema, desktopPortablePackageManifestSchema, desktopPortableRequirementSchema } from './desktop-portable-templates.js'

// An additive version-1 extension. Missing mediaType remains missing when parsing old archives,
// so existing content digests and installed revision identities are not rewritten.
export const desktopTemplateMediaTypeSchema = z.string().max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
export const desktopTemplateFidelityMemberSchema = desktopPortableMemberSchema.extend({ mediaType: desktopTemplateMediaTypeSchema.optional() }).strict()
export const desktopTemplateFidelityCoworkerSchema = desktopPortableCoworkerSchema.extend({
    members: z.array(desktopTemplateFidelityMemberSchema).max(2000),
}).strict()
export const desktopTemplateFidelityManifestSchema = desktopPortablePackageManifestSchema.extend({
    coworkers: z.array(desktopTemplateFidelityCoworkerSchema).min(1).max(12),
}).strict()
export type DesktopTemplateFidelityManifest = z.infer<typeof desktopTemplateFidelityManifestSchema>
export type DesktopTemplateFidelityMember = z.infer<typeof desktopTemplateFidelityMemberSchema>
export const desktopTemplateRequirementsSchema = z.array(desktopPortableRequirementSchema).max(200)
export type DesktopTemplateRequirement = z.infer<typeof desktopPortableRequirementSchema>
