import { z } from 'zod'
import { agentSetupSchema, providerSchema } from './agent.js'
import { triggerMethodSchema } from './trigger.js'

// An agent is already a well-formed folder on the engine, so a template captures the folder
// rather than re-describing it as JSON. The plan is what the folder looks like before it is
// archived: it drives the admin's security review and the editorial projection, so the UI
// never has to open the archive itself.

export const agentArchiveEntrySchema = z.object({
    // Relative to the agent directory, e.g. `workspace/.rerun/services.json`.
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    // Labels from SECRET_PATTERNS and SENSITIVE_PATH_PATTERNS.
    flagged: z.array(z.string()).default([]),
    // The engine decides what starts unchecked, not the review screen: it is the only side that
    // knows why a path is delicate.
    defaultExcluded: z.boolean().default(false),
    // Why this entry deserves a second look, e.g. `memory`, `agent database`.
    note: z.string().default(''),
})
export type AgentArchiveEntry = z.infer<typeof agentArchiveEntrySchema>

export const agentArchiveRedactionSchema = z.object({ path: z.string(), reason: z.string() })
export type AgentArchiveRedaction = z.infer<typeof agentArchiveRedactionSchema>

export const agentArchiveMcpAuthSchema = z.object({
    server: z.string(),
    kind: z.enum(['oauth', 'managed', 'device', 'unknown']).default('unknown'),
})
export type AgentArchiveMcpAuth = z.infer<typeof agentArchiveMcpAuthSchema>

export const agentArchiveSkillSchema = z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().default(''),
})

export const agentArchiveScheduleSchema = z.object({
    slug: z.string(),
    name: z.string(),
    cron: z.string().nullable(),
})

// The token is absent by construction: the archive ships every trigger with an empty one and the
// receiving engine mints its own, so a plan that named it would be the only place a live secret
// leaves the box.
export const agentArchiveTriggerSchema = z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().default(''),
    methods: z.array(triggerMethodSchema).default(['POST']),
    enabled: z.boolean().default(true),
})

export const agentArchivePlanSchema = z.object({
    agentId: z.string(),
    name: z.string(),
    displayName: z.string().default(''),
    description: z.string().default(''),
    provider: providerSchema,
    model: z.string(),
    // Enabled engine TOOL_KEYS only.
    tools: z.array(z.string()).default([]),
    files: z.array(agentArchiveEntrySchema).default([]),
    totalBytes: z.number().int().nonnegative(),
    // Read off `workspace/.rerun/services.json`, the agent's own connector registry.
    connectorSlugs: z.array(z.string()).default([]),
    skills: z.array(agentArchiveSkillSchema).default([]),
    schedules: z.array(agentArchiveScheduleSchema).default([]),
    // Defaulted rather than required: an engine that predates the trigger capture answers a plan
    // without the field, and a box being behind must not make the review screen unparseable.
    triggers: z.array(agentArchiveTriggerSchema).default([]),
    // `config.json` entries whose literal value was replaced by a `${VAR}` reference.
    strippedConfigKeys: z.array(z.string()).default([]),
    // The `.env` key names a copy will have to be given again. The archive ships the names with
    // empty values, so this is the shopping list, never the values themselves.
    envKeys: z.array(z.string()).default([]),
    // MCP servers whose OAuth bundle stayed on the source engine: a copy has to re-authorize.
    mcpAuth: z.array(agentArchiveMcpAuthSchema).default([]),
    // What the archive rewrote on its way out, so the review can state it rather than imply it.
    redactions: z.array(agentArchiveRedactionSchema).default([]),
    memoryCount: z.number().int().nonnegative().default(0),
    // The guided-setup answer the agent carries, and the INSTALL.md the copy will run, so a capture
    // can show both and force the answer before the archive is built. Defaulted rather than
    // required: an engine that predates INSTALL.md reads as unanswered. The conversation the
    // author's own install ran in is theirs, never the copy's.
    setup: agentSetupSchema.omit({ sessionId: true }).extend({ prompt: z.string().default('') }).prefault({}),
    engineCommit: z.string().nullable().default(null),
})
export type AgentArchivePlan = z.infer<typeof agentArchivePlanSchema>

// What starts out unchecked in a review, and what a capture leaves out when nobody says otherwise.
// It lives here rather than in either caller because the flag is the engine's own verdict, and the
// review screen and the MCP capture must not disagree on how to read it.
export function defaultExcludedPaths(plan: AgentArchivePlan): string[] {
    return plan.files.filter(file => file.defaultExcluded).map(file => file.path)
}

// What the receiving engine did with an archive. The caller has just handed over a tarball it
// never opened, so this is where it learns what the copy is missing: `.env` keys to ask for and
// MCP servers to re-authorize both travel as names, never as values.
export const agentImportResultSchema = z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().default(''),
    description: z.string().default(''),
    soul: z.string().default(''),
    envKeys: z.array(z.string()).default([]),
    mcpAuth: z.array(agentArchiveMcpAuthSchema).default([]),
    connectorSlugs: z.array(z.string()).default([]),
    // The webhooks the copy now owns, each behind a URL of its own: whatever service called the
    // source has to be pointed at the new ones.
    triggers: z.array(z.string()).default([]),
    // Memory files carry their own index, and the archive leaves it behind: this is how many of
    // them the copy managed to make recallable again.
    memoriesIndexed: z.number().int().nonnegative().default(0),
    // Entries the extraction filter refused, e.g. a path outside the agent folder.
    skippedPaths: z.array(z.string()).default([]),
})
export type AgentImportResult = z.infer<typeof agentImportResultSchema>
