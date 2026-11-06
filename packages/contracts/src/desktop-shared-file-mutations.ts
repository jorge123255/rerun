import { z } from 'zod'

// Shared create, exact edit, and search (D6 / E2). Version 1.
// The barrel export is a root fragment. This file does not define a workspace catalog.
// workspaceId uses the same bounds as desktopWorkspaceIdSchema in the canonical workspace contract.

export const DESKTOP_SHARED_FILE_MUTATIONS_CONTRACT_VERSION = 1 as const

export const DESKTOP_SHARED_FILE_MUTATION_LIMITS = {
    maxBytes: 256 * 1024,
    maxPath: 4096,
    maxPattern: 200,
    maxSearchResults: 100,
    defaultSearchResults: 50,
    maxFiles: 200,
    maxDepth: 8,
    maxLineChars: 4_000,
    snippetChars: 300,
    deadlineMs: 30_000,
} as const

export const SHARED_MUTATION_READ_GRANT = 'sharedFilesRead' as const
export const SHARED_MUTATION_WRITE_GRANT = 'sharedFilesWrite' as const

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const relativePath = z.string().min(1).max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxPath)

export const sharedMutationIdentitySchema = z.strictObject({
    workspaceId: z.number().int().positive().max(1_000_000),
    engineAgentId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    toolCallId: z.string().min(1).max(200),
})
export type SharedMutationIdentity = z.infer<typeof sharedMutationIdentitySchema>

export const sharedWriteArgumentsSchema = z.strictObject({
    path: relativePath,
    content: z.string().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxBytes),
})
export const sharedEditArgumentsSchema = z.strictObject({
    path: relativePath,
    oldString: z.string().min(1).max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxBytes),
    newString: z.string().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxBytes),
    replaceAll: z.boolean().optional(),
    expectedBytes: z.number().int().nonnegative().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxBytes),
    expectedSha256: sha256,
})
export const sharedSearchArgumentsSchema = z.strictObject({
    pattern: z.string().min(1).max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxPattern),
    path: z.string().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxPath).default('.'),
    maxResults: z.number().int().positive().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxSearchResults).default(DESKTOP_SHARED_FILE_MUTATION_LIMITS.defaultSearchResults),
})

export const sharedMutationCallSchema = z.strictObject({
    workspaceId: z.number().int().positive().max(1_000_000),
    engineAgentId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    toolCallId: z.string().min(1).max(200),
    tool: z.enum(['shared_write', 'shared_edit']),
    arguments: z.union([sharedWriteArgumentsSchema, sharedEditArgumentsSchema]),
}).superRefine((value, context) => {
    const write = value.tool === 'shared_write'
    const matches = write ? 'content' in value.arguments : 'oldString' in value.arguments
    if (!matches) context.addIssue({ code: 'custom', message: 'Tool arguments do not match' })
})
export type SharedMutationCall = z.infer<typeof sharedMutationCallSchema>

export const sharedMutationResultSchema = z.strictObject({
    status: z.enum(['saved', 'unchanged', 'refused', 'uncertain']),
    path: z.string().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxPath),
    message: z.string().min(1).max(500),
    code: z.enum(['exists', 'conflict', 'not_found', 'outside', 'symlink', 'malformed', 'oversized', 'grant', 'workspace', 'owner', 'uncertain']).optional(),
    bytes: z.number().int().nonnegative().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxBytes).optional(),
    sha256: sha256.optional(),
})
export type SharedMutationResult = z.infer<typeof sharedMutationResultSchema>

export const sharedSearchHitSchema = z.strictObject({
    path: relativePath,
    line: z.number().int().positive(),
    text: z.string().max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.snippetChars),
})
export const sharedSearchResultSchema = z.strictObject({
    hits: z.array(sharedSearchHitSchema).max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxSearchResults),
    truncated: z.boolean(),
    omitted: z.array(z.strictObject({
        path: relativePath,
        reason: z.enum(['too-large', 'binary', 'unreadable']),
    })).max(DESKTOP_SHARED_FILE_MUTATION_LIMITS.maxFiles),
})
export type SharedSearchResult = z.infer<typeof sharedSearchResultSchema>
