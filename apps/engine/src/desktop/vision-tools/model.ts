import { generateText } from 'ai'
import { DESKTOP_OPENCODE_PROVIDER } from '@rerun/contracts'
import { ensureCliAuth } from '../../connections/cli-auth.js'
import { modelFor, type ModelOverride } from '../../agents/providers.js'
import type { LoadedAgent } from '../../agents/types.js'
import type { DesktopVisionPorts } from './tools.js'

export const NO_VISION_MODEL = 'None of the models switched on for this OpenCode connection can read images. Switch one on that can (most Go models do), or go on without the image.'

type VisionModel = { id: string; images: boolean; plan?: string; price: { input: number; output: number; cacheRead: number | null } }
type VisionConnection = LoadedAgent['resolved']['connection'] & { providerModels?: VisionModel[]; config?: { providerModels?: VisionModel[] } }

export function desktopVisionModelFor(agent: LoadedAgent): ModelOverride | undefined | null {
    const { provider, model, connection } = agent.resolved
    if (String(provider) !== DESKTOP_OPENCODE_PROVIDER) return undefined
    const recorded = connection as VisionConnection | undefined
    const catalog = recorded?.config?.opencodeModels ?? recorded?.providerModels ?? recorded?.config?.providerModels
    if (!catalog?.length) return null
    const current = catalog.find(candidate => candidate.id === model)
    if (current?.images) return undefined
    return null
}

export function canonicalDesktopVisionModelPort(): DesktopVisionPorts {
    return {
        selectedModel: desktopVisionModelFor,
        modelFor: (agent, override) => modelFor(agent, override, undefined, undefined, { desktopVision: true }),
        ensureAuth: agent => ensureCliAuth(agent.resolved.provider, agent.resolved.connection),
        generateText,
    }
}
