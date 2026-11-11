import { createHash } from 'node:crypto'
import { DESKTOP_KIMI_PLATFORM_BASE_URL, type CustomProviderConfig, type CustomProviderSnapshot } from '@rerun/contracts'
import type { LanguageModelMiddleware } from 'ai'

export type KimiConversation = { agentId: string; sessionId: string }

export function isKimiPlatform(config: CustomProviderConfig): boolean {
    return config.preset === 'kimi-platform' && config.baseUrl.trim().replace(/\/+$/, '') === DESKTOP_KIMI_PLATFORM_BASE_URL
}

export function kimiReasoningScope(snapshot: CustomProviderSnapshot | undefined, model: string, conversation: KimiConversation): string | undefined {
    if (!snapshot || snapshot.state !== 'configured' || !isKimiPlatform(snapshot.config)) return
    // Include only non-secret identifiers. A credential or endpoint edit changes the revision.
    return createHash('sha256').update(JSON.stringify([
        'kimi-platform', snapshot.workspaceId, snapshot.connectionId, snapshot.revision, model, conversation.agentId, conversation.sessionId,
    ])).digest('hex')
}

export function isScopedKimiReasoning(part: { providerOptions?: { kimiPlatform?: { scope?: unknown } } }, scope: string): boolean {
    return part.providerOptions?.kimiPlatform?.scope === scope
}

export function kimiReasoningMiddleware(scope: string): LanguageModelMiddleware {
    const metadata = { kimiPlatform: { scope } }
    return {
        specificationVersion: 'v3',
        transformParams: async ({ params }) => ({
            ...params,
            prompt: params.prompt.map(message => message.role === 'assistant'
                ? { ...message, content: message.content.filter(part => part.type !== 'reasoning' || isScopedKimiReasoning(part, scope)) }
                : message),
        }),
        wrapGenerate: async ({ doGenerate }) => {
            const result = await doGenerate()
            return { ...result, content: result.content.map(part => part.type === 'reasoning'
                ? { ...part, providerMetadata: { ...part.providerMetadata, ...metadata } }
                : part) }
        },
        wrapStream: async ({ doStream }) => {
            const result = await doStream()
            return { ...result, stream: result.stream.pipeThrough(new TransformStream({
                transform(part, controller) {
                    controller.enqueue(part.type === 'reasoning-end'
                        ? { ...part, providerMetadata: { ...part.providerMetadata, ...metadata } }
                        : part)
                },
            })) }
        },
    }
}
