import { desktopCodexToolCatalog, desktopRerunToolCatalog } from '@rerun/contracts'
import { z } from 'zod'

export type DesktopToolGroup = 'rerun' | 'codex'
export type CoworkerToolRow = { id: string; label: string; description: string; tools: readonly string[]; available: boolean; unavailableReason?: string; enabled: boolean }
export type CoworkerTools = Record<DesktopToolGroup, CoworkerToolRow[]>

export const coworkerToolPatch = z.strictObject({ group: z.enum(['rerun', 'codex']), id: z.string(), enabled: z.boolean() })
export type CoworkerToolPatch = z.infer<typeof coworkerToolPatch>

export const coworkerToolCatalogs = { rerun: desktopRerunToolCatalog, codex: desktopCodexToolCatalog }
