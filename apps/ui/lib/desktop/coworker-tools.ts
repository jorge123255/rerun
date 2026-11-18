import { desktopClaudeToolCatalog, desktopCodexToolCatalog, desktopRerunToolCatalog } from '@rerun/contracts'
import { z } from 'zod'

export type DesktopToolGroup = 'rerun' | 'codex' | 'claude'
export type CoworkerToolRow = { id: string; label: string; description: string; tools: readonly string[]; available: boolean; unavailableReason?: string; parent?: string; enabled: boolean }
export type CoworkerTools = Record<DesktopToolGroup, CoworkerToolRow[]>

export const coworkerToolPatch = z.strictObject({ group: z.enum(['rerun', 'codex', 'claude']), id: z.string(), enabled: z.boolean() })
export type CoworkerToolPatch = z.infer<typeof coworkerToolPatch>

// Managed Foreman has its own explicit permission control, not an ordinary coworker row.
export const coworkerToolCatalogs = { rerun: desktopRerunToolCatalog.filter(row => row.id !== 'foremanAgentFilesRead' && row.id !== 'foremanAgentFilesWrite'), codex: desktopCodexToolCatalog, claude: desktopClaudeToolCatalog }
