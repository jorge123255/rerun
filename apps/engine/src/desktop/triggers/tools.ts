import { z } from 'zod'
import { providerSchema, triggerMethodSchema } from '@rerun/contracts'
import type { DesktopTriggerLifecycle } from './lifecycle.js'
import type { DesktopTriggerAuthority } from './types.js'

export type DesktopTriggerToolResult = string

type ToolDef = {
    description: string
    inputSchema: z.ZodTypeAny
    execute: (args: any) => Promise<DesktopTriggerToolResult>
}

/**
 * Model-visible trigger tools. Secret-bearing fields (token/url with token) are never listed.
 * Root wires these into the central registry only when the coworker grant and setup allow it.
 */
export function createDesktopTriggerToolFactory(deps: {
    authority: DesktopTriggerAuthority
    lifecycle: DesktopTriggerLifecycle
    /** Fresh check each call — must mirror current grant/setup/shutdown/deletion. */
    assertModelToolAllowed: (engineAgentId: string) => Promise<void>
    newRequestId: () => string
}) {
    return function desktopTriggerTools(engineAgentId: string): Record<string, ToolDef> {
        const guard = async () => {
            deps.authority.assertActive()
            await deps.assertModelToolAllowed(engineAgentId)
            deps.authority.assertActive()
        }

        return {
            trigger_list: {
                description: 'List your webhook triggers. Each one exposes a URL that starts a run when an external service calls it. Instruction bodies are not included here; read one in full with trigger_get.',
                inputSchema: z.object({}),
                execute: async () => {
                    await guard()
                    const triggers = await deps.lifecycle.list(engineAgentId)
                    if (triggers.length === 0) return 'No webhook triggers yet.'
                    return triggers
                        .map(t => {
                            const state = t.enabled ? `${t.fireCount} call(s)${t.lastFiredAt ? `, last ${t.lastFiredAt}` : ''}` : 'disabled'
                            return `- ${t.name} (${t.slug}): ${t.methods.join('/')}, ${state}`
                        })
                        .join('\n')
                },
            },
            trigger_get: {
                description: 'Read one webhook trigger in full, including its instruction body. The live webhook secret is not included; open Triggers in the app to copy the URL.',
                inputSchema: z.object({ slug: z.string() }),
                execute: async ({ slug }) => {
                    await guard()
                    const trigger = await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })
                    const origin = deps.authority.ingressOrigin()
                    const urlLine = origin.enabled && origin.origin
                        ? `Webhook URLs are managed in the Triggers tab (secret not shown to tools).`
                        : 'Its public URL is not available until a hosting decision enables ingress — open the coworker's Triggers tab in Rerun.'
                    return [
                        `${trigger.name} (${trigger.slug})`,
                        trigger.description ? `Description: ${trigger.description}` : '',
                        `Methods: ${trigger.methods.join('/')}`,
                        `Enabled: ${trigger.enabled}`,
                        `Calls: ${trigger.fireCount}${trigger.lastFiredAt ? ` (last ${trigger.lastFiredAt})` : ''}`,
                        `Revision: ${trigger.revision}`,
                        urlLine,
                        '',
                        trigger.body,
                    ].filter(Boolean).join('\n')
                },
            },
            trigger_create: {
                description: 'Create a webhook trigger. The body is the instruction you will execute; the caller payload is attached. Tell the user to copy the URL from the Triggers tab.',
                inputSchema: z.object({
                    name: z.string(),
                    description: z.string(),
                    body: z.string(),
                    methods: z.array(triggerMethodSchema).optional(),
                    provider: providerSchema.optional(),
                    model: z.string().optional(),
                }),
                execute: async ({ name, description, body, methods, provider, model }) => {
                    await guard()
                    if (provider && !model) return 'Provide a model together with a provider, or omit both to follow the coworker model.'
                    const trigger = await deps.lifecycle.create(engineAgentId, {
                        requestId: deps.newRequestId(),
                        name,
                        description,
                        body,
                        methods: methods ?? ['POST'],
                        provider: provider ?? null,
                        model: model ?? null,
                    })
                    return `Created trigger ${trigger.slug} (${trigger.methods.join('/')}). Copy its URL from the Triggers tab — tools never receive the live secret.`
                },
            },
            trigger_update: {
                description: 'Update a webhook trigger description, body, methods, model, or enable/disable it. Name and URL slug cannot change. Passing body replaces the entire instruction.',
                inputSchema: z.object({
                    slug: z.string(),
                    description: z.string().optional(),
                    body: z.string().optional(),
                    methods: z.array(triggerMethodSchema).optional(),
                    enabled: z.boolean().optional(),
                    provider: providerSchema.optional(),
                    model: z.string().optional(),
                }),
                execute: async (args) => {
                    await guard()
                    const current = await deps.lifecycle.get(engineAgentId, args.slug, { includeToken: false })
                    await deps.lifecycle.update(engineAgentId, args.slug, {
                        requestId: deps.newRequestId(),
                        expectedRevision: current.revision,
                        description: args.description,
                        body: args.body,
                        methods: args.methods,
                        enabled: args.enabled,
                        provider: args.provider,
                        model: args.model,
                    })
                    return `Updated trigger ${args.slug}`
                },
            },
            trigger_rotate_token: {
                description: 'Rotate a webhook trigger secret, which changes its URL. Confirm with the user first. The new URL is only available in the Triggers tab.',
                inputSchema: z.object({ slug: z.string() }),
                execute: async ({ slug }) => {
                    await guard()
                    const current = await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })
                    await deps.lifecycle.rotate(engineAgentId, slug, {
                        requestId: deps.newRequestId(),
                        expectedRevision: current.revision,
                    })
                    return `Rotated the secret of ${slug}. Copy the new URL from the Triggers tab.`
                },
            },
            trigger_delete: {
                description: 'Delete a webhook trigger. Its URL stops working immediately. Historical runs are retained.',
                inputSchema: z.object({ slug: z.string() }),
                execute: async ({ slug }) => {
                    await guard()
                    const current = await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })
                    await deps.lifecycle.remove(engineAgentId, slug, {
                        requestId: deps.newRequestId(),
                        expectedRevision: current.revision,
                    })
                    return `Deleted trigger ${slug}`
                },
            },
        }
    }
}
