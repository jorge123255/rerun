import type { CustomProviderConfig, CustomProviderModel } from './desktop-custom-provider.js'

/**
 * Ollama on the Mac, as two named providers over the custom OpenAI-compatible runtime.
 *
 * Both are ordinary registered custom connections: the same revisions, encrypted key custody and
 * pinned network path. What makes one "Ollama" is its exact base address, which is fixed here and
 * never typed by the owner. Addresses and the model-list route follow docs.ollama.com
 * (api/openai-compatibility, api/authentication, cloud/models).
 */
export const DESKTOP_OLLAMA_KINDS = ['ollama', 'ollama-cloud'] as const
export type DesktopOllamaKind = (typeof DESKTOP_OLLAMA_KINDS)[number]

export const DESKTOP_OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
export const DESKTOP_OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys'

export const DESKTOP_OLLAMA: Record<DesktopOllamaKind, { label: string; name: string; baseUrl: string; tagsUrl: string; keyRequired: boolean }> = {
    // Loopback only: the address is this Mac and cannot be changed.
    ollama: { label: 'Ollama (this Mac)', name: 'Ollama (this Mac)', baseUrl: 'http://127.0.0.1:11434/v1', tagsUrl: 'http://127.0.0.1:11434/api/tags', keyRequired: false },
    'ollama-cloud': { label: 'Ollama Cloud', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', tagsUrl: 'https://ollama.com/api/tags', keyRequired: true },
}

const plain = (value: string) => value.trim().replace(/\/+$/, '')

export function desktopOllamaKindOfBase(baseUrl: string | null | undefined): DesktopOllamaKind | null {
    if (!baseUrl) return null
    const base = plain(baseUrl)
    return DESKTOP_OLLAMA_KINDS.find(kind => DESKTOP_OLLAMA[kind].baseUrl === base) ?? null
}

/** Which Ollama provider a connection is, or null for anything else (including other custom endpoints). */
export function desktopOllamaKind(connection: { provider: string; baseUrl?: string | null } | null | undefined): DesktopOllamaKind | null {
    return connection?.provider === 'custom' ? desktopOllamaKindOfBase(connection.baseUrl) : null
}

export function desktopOllamaPolicy(kind: DesktopOllamaKind): CustomProviderConfig['policy'] {
    const local = kind === 'ollama'
    return { reviewedOrigin: new URL(DESKTOP_OLLAMA[kind].baseUrl).origin, allowHttp: local, allowPrivate: local }
}

export function desktopOllamaConfig(kind: DesktopOllamaKind, models: CustomProviderModel[], name: string = DESKTOP_OLLAMA[kind].name): CustomProviderConfig {
    return { name, baseUrl: DESKTOP_OLLAMA[kind].baseUrl, preset: null, models, contextWindow: null, vision: false, policy: desktopOllamaPolicy(kind) }
}
