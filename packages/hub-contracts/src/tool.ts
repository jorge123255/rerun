import { z } from 'zod'

export const toolDescriptorSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
})
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

export const toolFamilySchema = z.object({
    family: z.string(),
    description: z.string().default(''),
    enabled: z.boolean().optional(),
    tools: z.array(toolDescriptorSchema).default([]),
})
export type ToolFamily = z.infer<typeof toolFamilySchema>

export const toolsListSchema = z.object({ families: z.array(toolFamilySchema) })
