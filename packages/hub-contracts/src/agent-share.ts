import { z } from 'zod'
import type { AgentArchivePlan } from './agent-archive.js'
import { templateAgentSchema, templateConnectorSchema } from './template.js'

// A share link is a template capture without the marketplace: the same engine archive, uploaded
// once and handed to one person by URL. It is snapshot rather than live, so the link keeps working
// after the source agent is renamed, switched off or deleted, and it can never carry data the
// agent gained after the link was made.

// The three answers the sharer gives. Everything else about the agent travels either way: its
// personality, its skills, its schedules, its webhooks, the shape of its config.
export const agentShareIncludeSchema = z.object({
    memories: z.boolean().default(false),
    database: z.boolean().default(false),
    files: z.boolean().default(true),
})
export type AgentShareInclude = z.infer<typeof agentShareIncludeSchema>

export const AGENT_SHARE_INCLUDE_NONE: AgentShareInclude = { memories: false, database: false, files: false }

// The schema's own defaults are what a form posts, not what an unknown caller means: it defaults
// `files` to true, and a tool call that left `include` out never asked for a workspace folder.
// Nothing travels unless it is named, which is also what the dialog does.
export function resolveShareInclude(input: unknown): AgentShareInclude {
    const sent = (input ?? {}) as Record<string, unknown>
    const named = (key: keyof AgentShareInclude): boolean => sent[key] === true
    return { memories: named('memories'), database: named('database'), files: named('files') }
}

const MEMORY_PREFIX = 'memory/'
const WORKSPACE_PREFIX = 'workspace/'
const AGENT_DB_PATH = 'data/agent.db'
// The agent's own connector registry. It lives under `workspace/` but it is not workspace data:
// dropping it would land a copy that cannot say which services it needs reconnecting.
const REGISTRY_PATH = 'workspace/.rerun/services.json'

// Turns the three switches into the `exclude` list the engine's archive routes take.
//
// Unlike the template capture wizard, a flagged file can never be brought back: an author capturing
// their own agent for the marketplace knows what is in it, someone sending an agent to a colleague
// is trusting us to have looked.
export function shareExcludePaths(plan: AgentArchivePlan, include: AgentShareInclude): string[] {
    return plan.files
        .filter(file => {
            if (file.flagged.length > 0) return true
            if (file.path.startsWith(MEMORY_PREFIX)) return !include.memories
            if (file.path === AGENT_DB_PATH) return !include.database
            if (file.path === REGISTRY_PATH) return false
            if (file.path.startsWith(WORKSPACE_PREFIX)) return !include.files
            return false
        })
        .map(file => file.path)
}

// What each switch would carry, so the form can price the decision instead of asking it blind.
export const shareBucketSchema = z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
})
export type ShareBucket = z.infer<typeof shareBucketSchema>
export type AgentShareContents = { memories: ShareBucket; database: ShareBucket; files: ShareBucket }

export function shareContents(plan: AgentArchivePlan): AgentShareContents {
    const bucket = (match: (path: string) => boolean): ShareBucket => {
        const entries = plan.files.filter(file => file.flagged.length === 0 && match(file.path))
        return { count: entries.length, bytes: entries.reduce((total, file) => total + file.bytes, 0) }
    }
    return {
        memories: bucket(path => path.startsWith(MEMORY_PREFIX)),
        database: bucket(path => path === AGENT_DB_PATH),
        files: bucket(path => path.startsWith(WORKSPACE_PREFIX) && path !== REGISTRY_PATH),
    }
}

// The card the recipient sees, frozen at link creation. Deliberately the same `templateAgent`
// shape a template card carries, produced by the same `projectAgent`: the two describe the same
// object, and a share that invented a second shape would need a second set of components to
// render it and a second place to get the redaction wrong.
//
// It holds nothing about the infrastructure it came from: no engine id, no bucket path, no
// workspace, and no file paths (a path names a client).
export const agentSharePreviewSchema = z.object({
    agent: templateAgentSchema,
    // Denormalised to name + icon, so the card resolves no slug against `services`.
    connectors: z.array(templateConnectorSchema).default([]),
    // Counted, not named. Whoever holds the token can read this card, and a key called
    // `ACME_INTERNAL_API_KEY` tells a stranger who the sender works for. The names are the copy
    // owner's business: the engine hands them back in `AgentImportResult` after the install.
    envKeyCount: z.number().int().nonnegative().default(0),
    mcpAuthCount: z.number().int().nonnegative().default(0),
    include: agentShareIncludeSchema,
    contents: z.object({
        memories: shareBucketSchema,
        database: shareBucketSchema,
        files: shareBucketSchema,
    }),
    // A snapshot ages, and the recipient is the one who should get to judge by how much.
    capturedAt: z.string(),
    sharedBy: z.string().nullable().default(null),
})
export type AgentSharePreview = z.infer<typeof agentSharePreviewSchema>
