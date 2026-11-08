import { z } from 'zod'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'

export const desktopTheme = z.enum(['system', 'light', 'dark'])
const apiProvider = z.enum(['openai', 'anthropic', 'google', 'openrouter'])
export const desktopProvider = z.enum([...apiProvider.options, 'codex', 'claude', 'custom'])
export type DesktopProvider = z.infer<typeof desktopProvider>
const id = z.string().trim().min(1).max(256)
export const settingsChange = z.discriminatedUnion('action', [
    z.object({ action: z.literal('key'), provider: apiProvider, connectionId: id.optional(), apiKey: z.string().trim().min(1).max(4096) }),
    z.object({ action: z.literal('default'), connectionId: id, model: id, reasoningEffort: id.nullable().optional() }),
    z.object({ action: z.literal('models'), connectionId: id, models: z.array(id).max(256), extraModels: z.array(id).max(256) }),
    z.object({ action: z.literal('endpoint'), connectionId: id, baseUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]) }),
    z.object({ action: z.literal('appearance'), theme: desktopTheme }),
    z.object({ action: z.literal('workspace'), name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX) }),
])
export type SettingsChange = z.infer<typeof settingsChange>
