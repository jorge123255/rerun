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

/** The exact setup addition derived from the immutable captured requirement names. */
export function desktopTemplateGuidedSetup(setup: { required: boolean | null; prompt: string }, rawRequirements: unknown) {
    const requirements = desktopTemplateRequirementsSchema.parse(rawRequirements ?? [])
    for (const requirement of requirements) {
        const pattern = requirement.kind === 'environment-key' || requirement.kind === 'credential-name'
            ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
        if (!pattern.test(requirement.name)) throw new Error('Template requirement names are not supported')
    }
    if (!requirements.length) return { prompt: setup.prompt, required: setup.required === true }
    const prompt = [setup.prompt, 'To provide again on a copy:', ...requirements.map(item => `- ${item.kind}: ${item.name}`),
        'These are setup requirements only. Nothing is connected and no permission was enabled. Ask the owner to complete or explicitly skip missing setup.'].filter(Boolean).join('\n')
    if (new TextEncoder().encode(prompt).byteLength > 1048576) throw new Error('Template setup requirements exceed the prompt bound')
    return { prompt, required: true }
}
