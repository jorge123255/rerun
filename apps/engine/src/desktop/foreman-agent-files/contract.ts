// Runtime copy of packages/contracts/src/desktop-foreman-agent-files.ts. The contracts barrel is unchanged until root exports that module.
import { z } from 'zod'

/** Default-off Foreman gates. Root appends these ids to `desktopRerunGrantIds` before they can be saved. */
export const foremanAgentFileGrantIds = ['foremanAgentFilesRead', 'foremanAgentFilesWrite'] as const
export type ForemanAgentFileGrantId = (typeof foremanAgentFileGrantIds)[number]

export const FOREMAN_AGENT_FILE_READ_TOOLS = ['agent_files_read', 'agent_files_list', 'agent_files_search'] as const
export const FOREMAN_AGENT_FILE_WRITE_TOOLS = ['agent_files_write', 'agent_files_edit'] as const
export const FOREMAN_AGENT_FILE_TOOLS = [...FOREMAN_AGENT_FILE_READ_TOOLS, ...FOREMAN_AGENT_FILE_WRITE_TOOLS] as const

export const FOREMAN_AGENT_FILE_READ_BYTES = 32 * 1024
export const FOREMAN_AGENT_FILE_WRITE_BYTES = 256 * 1024

export const FOREMAN_AGENT_FILE_COPY = {
    off: 'Cross-coworker file access is turned off for Foreman.',
    workspace: 'That coworker is not in this workspace.',
    ambiguous: 'That coworker name matches more than one coworker in this workspace.',
    path: 'Use a visible relative path inside that coworker’s workspace.',
    text: 'This file must contain UTF-8 text. Nothing was returned.',
    nonTextWrite: 'Only a visible .txt or .md file can be written. Nothing was saved.',
    unavailable: 'That file is unavailable in this coworker’s workspace.',
    admission: 'This Foreman run is no longer active.',
    unknown: 'No save acknowledgement is available. Inspect Files; this exact call will not be published again if it was claimed.',
    historical: 'Visible files include documents this coworker saved earlier. Chats, memories, credentials, and hidden internal stores are not included.',
} as const

const INTERNAL_SEGMENT = /^\.rerun(?:-skill)?(?:$|[-.])/i

export function foremanAgentVisiblePath(value: string, kind: 'any' | 'directory' | 'text' = 'any'): string {
    if (!value || value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) {
        throw new Error(FOREMAN_AGENT_FILE_COPY.path)
    }
    const parts = value.split('/')
    if (parts.some(part => !part || part.startsWith('.') || part === 'node_modules' || part.length > 255 || INTERNAL_SEGMENT.test(part))) {
        throw new Error(FOREMAN_AGENT_FILE_COPY.path)
    }
    if (kind === 'text' && !/\.(txt|md)$/i.test(value)) throw new Error(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    return value
}

export function foremanAgentFileGrantOn(tools: { desktopToolGrants?: Record<string, boolean | undefined> } | null | undefined, id: ForemanAgentFileGrantId): boolean {
    return tools?.desktopToolGrants?.[id] === true
}

export function foremanAgentBoundedText(content: string): string {
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength > FOREMAN_AGENT_FILE_WRITE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) throw new Error(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    try {
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== content) throw new Error('unaligned')
    } catch {
        throw new Error(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    }
    return content
}

export const foremanAgentFileCoworkerSchema = z.string().trim().min(1).max(200)
export const foremanAgentFileReadInput = z.object({ coworker: foremanAgentFileCoworkerSchema, path: z.string() }).strict()
export const foremanAgentFileListInput = z.object({ coworker: foremanAgentFileCoworkerSchema, path: z.string().default('.') }).strict()
export const foremanAgentFileSearchInput = z.object({
    coworker: foremanAgentFileCoworkerSchema,
    path: z.string().default('.'),
    pattern: z.string().min(1).max(256),
    maxResults: z.number().int().positive().max(50).default(20),
}).strict()
export const foremanAgentFileWriteInput = z.object({ coworker: foremanAgentFileCoworkerSchema, path: z.string(), content: z.string().max(FOREMAN_AGENT_FILE_WRITE_BYTES) }).strict()
export const foremanAgentFileEditInput = z.object({
    coworker: foremanAgentFileCoworkerSchema,
    path: z.string(),
    oldString: z.string().min(1).max(FOREMAN_AGENT_FILE_WRITE_BYTES),
    newString: z.string().max(FOREMAN_AGENT_FILE_WRITE_BYTES),
    replaceAll: z.boolean().optional(),
}).strict()

export const foremanAgentFilePublishResultSchema = z.object({
    status: z.enum(['saved', 'unchanged', 'unknown', 'refused']),
    path: z.string().optional(),
    message: z.string().min(1).max(500),
}).strict()
export type ForemanAgentFilePublishResult = z.infer<typeof foremanAgentFilePublishResultSchema>

/** Rows root appends to `desktopRerunToolCatalog`. They stay off until the matching grant is saved as true. */
export const foremanAgentFileCatalogEntries = [
    {
        id: 'foremanAgentFilesRead',
        label: 'Read other coworkers’ files',
        description: 'Let Foreman read, list, and search visible files in another coworker’s Files in this workspace. Includes documents saved earlier. Does not include chats, memories, credentials, or hidden internal stores.',
        tools: [...FOREMAN_AGENT_FILE_READ_TOOLS],
        available: true,
    },
    {
        id: 'foremanAgentFilesWrite',
        label: 'Edit other coworkers’ files',
        description: 'Let Foreman create and edit visible text or Markdown files in another coworker’s Files through the Mac file receipt. Non-text is refused. An uncertain save is not retried.',
        tools: [...FOREMAN_AGENT_FILE_WRITE_TOOLS],
        available: true,
    },
] as const
