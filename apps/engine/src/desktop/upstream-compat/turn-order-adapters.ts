import type { Provider } from '@rerun/contracts'
import { answeringModelId, cardCallTiming, turnOrder, type TurnOrder } from '../../agents/turn-order.js'

// Pure adapters for Claude/Anthropic consumers. Root wires these into the Claude runner prompt and
// card tool descriptions; this package does not edit the bundled Claude runner or subscription login.

export type TurnOrderDecision = {
    provider: Provider
    model: string
    answeringModelId: string
    order: TurnOrder
    cardTiming: string
}

export function decideTurnOrder(provider: Provider, model: string): TurnOrderDecision {
    const id = answeringModelId(provider, model)
    const order = turnOrder(provider, model)
    return { provider, model, answeringModelId: id, order, cardTiming: cardCallTiming(order) }
}

export function claudeCardCallTiming(model: string, provider: Provider = 'claude'): string {
    return decideTurnOrder(provider, model).cardTiming
}
