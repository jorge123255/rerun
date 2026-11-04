import { tool, type ToolSet } from 'ai'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { configPath, soulPath } from '../config/paths.js'
import { agentConfigSchema, verbositySchema } from '../agents/types.js'
import { reloadAgent } from '../agents/registry.js'
import { withAgentLock } from '../agents/lock.js'
import { writeAgentConfig } from '../agents/config-write.js'
import type { RunContext } from '../runtime/context.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

// The Mac slice of the hosted self family: only the own-instruction rewrite and the reply
// length change, each behind an explicit per-coworker grant and the shared Improve itself
// master. Package installation, MCP registration, sign-ins and auto-memory curation stay
// out of the desktop runtime entirely (see docs/desktop-self-instruction-controls.md).
export function desktopSelfInstructionTools(ctx: RunContext): ToolSet {
    const tools: ToolSet = {}
    if (hasDesktopToolGrant(ctx.agent.config, 'selfInstruction')) {
        tools.soul_update = tool({
            description:
                'Rewrite your own instructions — the SOUL.md identity, mission and voice at the top of your system prompt. Your current instructions are already shown to you there; produce the full updated version (not a diff). Use this to durably evolve who you are as you learn from the user. The new instructions take effect from your next message onward. For facts and procedures use memory_write instead; reserve this for genuine changes to your identity or mission.',
            inputSchema: z.object({
                soul: z.string().trim().min(1).describe('The complete new instructions in Markdown, replacing the previous SOUL.md content'),
                reason: z.string().describe('One sentence on what changed and why, for the user to see'),
            }),
            execute: async ({ soul, reason }) => {
                await requireDesktopToolGrant(ctx, 'selfInstruction')
                await writeFile(soulPath(ctx.agent.id), `${soul.trim()}\n`, 'utf8')
                await reloadAgent(ctx.agent.id)
                return `Instructions updated (${reason}). It takes effect from your next message onward.`
            },
        })
    }
    if (hasDesktopToolGrant(ctx.agent.config, 'verbositySet')) {
        tools.verbosity_set = tool({
            description:
                'Change how long your answers to this user are, for good. Levels are minimal (one or two sentences), concise (the result and what changes a decision), normal (your native behaviour) and detailed (reasoning, alternatives and caveats spelled out). Use it when the user asks for durably shorter or longer answers, or once they have agreed to a change you proposed. It only moves the length of your prose: the work, the checks and the deliverables stay the same.',
            inputSchema: z.object({
                level: verbositySchema.describe('The new response length'),
                reason: z.string().describe('One sentence on why it changed, for the user to see'),
            }),
            execute: async ({ level, reason }) => {
                await requireDesktopToolGrant(ctx, 'verbositySet')
                await withAgentLock(ctx.agent.id, async () => {
                    const config = agentConfigSchema.parse(JSON.parse(await readFile(configPath(ctx.agent.id), 'utf8')))
                    config.verbosity = level
                    await writeAgentConfig(ctx.agent.id, config)
                    await reloadAgent(ctx.agent.id)
                })
                return `Response length set to ${level} (${reason}). It takes effect from your next message onward.`
            },
        })
    }
    return tools
}
