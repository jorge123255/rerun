import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { deadlineSignal, raceAbort } from '../../lib/abort.js'
import { readAgentConfig } from '../../agents/loader.js'
import type { AgentConfig, LoadedAgent } from '../../agents/types.js'
import type { ModelOverride } from '../../agents/providers.js'
import type { RunContext } from '../../runtime/context.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { desktopVisionImageMessages } from './files.js'
import { canonicalDesktopVisionModelPort, NO_VISION_MODEL } from './model.js'

const VISION_TIMEOUT_MS = 10 * 60 * 1000

export type DesktopVisionPorts = {
    selectedModel(agent: LoadedAgent): ModelOverride | undefined | null
    modelFor(agent: LoadedAgent, override: ModelOverride | undefined, sessionId: string): LanguageModel
    ensureAuth(agent: LoadedAgent): Promise<() => void>
    generateText(input: { model: LanguageModel; messages: ModelMessage[]; abortSignal: AbortSignal }): Promise<{ text: string }>
    readConfig?(agentId: string): Promise<AgentConfig | null>
}

async function requireDesktopVisionGrant(ctx: RunContext, ports: DesktopVisionPorts) {
    const current = await (ports.readConfig ?? readAgentConfig)(ctx.agent.id)
    if (!current?.enabled || !hasDesktopToolGrant(current, 'vision')) throw new Error('Vision analysis is turned off for this coworker.')
    ctx.abortSignal?.throwIfAborted()
}

export function desktopVisionTools(ctx: RunContext, ports: DesktopVisionPorts = canonicalDesktopVisionModelPort(), timeoutMs = VISION_TIMEOUT_MS): ToolSet {
    return {
        vision_analyze: tool({
            description: 'Analyze an image file from your workspace with a multimodal model. Provide a prompt describing what to look for (e.g. extract text, describe the layout, read a chart). Useful on screenshots saved by browser_navigate.',
            inputSchema: z.object({
                imagePath: z.string().describe('Workspace-relative path to a PNG, JPEG, GIF or WebP image'),
                prompt: z.string().describe('What you want to know about the image'),
            }),
            execute: async ({ imagePath, prompt }, { abortSignal }) => {
                if (!ctx.runId) throw new Error('Vision analysis requires an active run.')
                await requireDesktopVisionGrant(ctx, ports)
                let messages: ModelMessage[]
                try {
                    messages = await desktopVisionImageMessages(ctx, imagePath, prompt)
                } catch (error) {
                    ctx.abortSignal?.throwIfAborted()
                    return `Could not read ${imagePath} as an image: ${(error as Error).message}`
                }
                const seeing = ports.selectedModel(ctx.agent)
                if (seeing === null) return NO_VISION_MODEL
                const runSignal = ctx.abortSignal ?? abortSignal
                const signal = deadlineSignal(timeoutMs, runSignal)
                let release = () => {}
                try {
                    await requireDesktopVisionGrant(ctx, ports)
                    release = await ports.ensureAuth(ctx.agent)
                    await requireDesktopVisionGrant(ctx, ports)
                    signal.throwIfAborted()
                    const { text } = await raceAbort(ports.generateText({ model: ports.modelFor(ctx.agent, seeing, ctx.sessionId), messages, abortSignal: signal }), signal)
                    return text || '(the model returned no text)'
                } catch (error) {
                    if (runSignal?.aborted) throw error
                    if (signal.aborted) {
                        ctx.logger.warn({ agent: ctx.agent.id, provider: ctx.agent.resolved.provider, imagePath, timeoutMs }, 'vision analysis timed out')
                        return `Vision analysis timed out after ${Math.round(timeoutMs / 60_000)} min with no answer from the model. Try again, or go on without it.`
                    }
                    return `Vision analysis failed (the configured model may not support images): ${(error as Error).message}`
                } finally {
                    release()
                }
            },
        }),
    }
}
