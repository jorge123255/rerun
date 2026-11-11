import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { boxPlanSchema, isDesktopSubscriptionProvider, trialModelFor, type BoxPlan, type Provider } from '@rerun/contracts'
import { boxPlanPath } from '../config/paths.js'
import { clearAgentCache } from '../agents/registry.js'

const UNRESTRICTED: BoxPlan = { premiumModels: true }

// Read synchronously and held: `pairFor` resolves a model without awaiting, and every write to the
// file goes through this module.
let cached: BoxPlan | undefined

export function readBoxPlan(): BoxPlan {
    if (cached) return cached
    const path = boxPlanPath()
    try {
        cached = existsSync(path) ? boxPlanSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : UNRESTRICTED
    } catch {
        cached = UNRESTRICTED
    }
    return cached
}

// Same reason as the box default: every cached agent holds a pair resolved under the old plan.
export async function writeBoxPlan(next: BoxPlan): Promise<BoxPlan> {
    const target = boxPlanPath()
    const tmp = `${target}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 4)}\n`, 'utf8')
    await rename(tmp, target)
    cached = next
    clearAgentCache()
    return next
}

// The model a run really gets. The pin itself is never rewritten, so paying gives Opus back to every
// agent that asked for it.
export function allowedModel(provider: Provider, model: string): string {
    return provider === 'custom' || provider === 'opencode' || isDesktopSubscriptionProvider(provider) || readBoxPlan().premiumModels ? model : trialModelFor(provider, model)
}
