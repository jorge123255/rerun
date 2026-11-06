import { generateText } from 'ai'
import { ensureCliAuth } from '../../connections/cli-auth.js'
import { modelFor, type ModelOverride } from '../../agents/providers.js'
import type { LoadedAgent } from '../../agents/types.js'
import type { DesktopVisionPorts } from './tools.js'

export const NO_VISION_MODEL = 'None of the models switched on for this OpenCode connection can read images. Switch one on that can (most Go models do), or go on without the image.'

type VisionModel = { id: string; images: boolean; plan?: string; price: { input: number; output: number; cacheRead: number | null } }
type VisionConnection = LoadedAgent['resolved']['connection'] & { providerModels?: VisionModel[] }

export function desktopVisionModelFor(agent: LoadedAgent): ModelOverride | undefined | null {
    const { provider, model, connection } = agent.resolved
    if (provider !== 'opencode') return undefined
    const catalog = (connection as VisionConnection)?.providerModels
    if (!catalog?.length) return null
    const current = catalog.find(candidate => candidate.id === model)
    if (current?.images) return undefined
    const seeing = catalog.filter(candidate => candidate.plan === 'go' && candidate.images).sort((a, b) => a.price.input + a.price.output - b.price.input - b.price.output)
    return seeing[0] ? { model: seeing[0].id } : null
}

export function canonicalDesktopVisionModelPort(): DesktopVisionPorts {
    return {
        selectedModel: desktopVisionModelFor,
        modelFor: (agent, override, sessionId) => modelFor(agent, override, undefined, undefined, { claudeTools: ['Read'], sessionId }),
        ensureAuth: agent => ensureCliAuth(agent.resolved.provider, agent.resolved.connection),
        generateText,
    }
}
