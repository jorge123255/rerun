// The part of the Workers runtime this relay uses, typed here so the code also runs under the
// Node test double in test/fake-runtime.ts. The names match the Workers API.

export interface RelaySocket {
    send(message: string): void
    close(code?: number, reason?: string): void
    serializeAttachment(value: unknown): void
    deserializeAttachment(): unknown
}

export interface RelayStorage {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    list<T>(options: { prefix: string }): Promise<Map<string, T>>
    getAlarm(): Promise<number | null>
    setAlarm(when: number): Promise<void>
}

export interface RelayState {
    storage: RelayStorage
    acceptWebSocket(socket: RelaySocket, tags?: string[]): void
    getWebSockets(tag?: string): RelaySocket[]
    setWebSocketAutoResponse?(pair: unknown): void
    getWebSocketAutoResponseTimestamp?(socket: RelaySocket): Date | null
}

export interface RelayNamespace {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
}

export interface Env {
    VOICE_RELAY: RelayNamespace
    /** Secret. JSON object: per-install id to that install's relay secret. */
    RELAY_INSTALLS?: string
    /** "on" checks the caller of the ElevenLabs path against ELEVENLABS_EGRESS_IPS. Off by default. */
    ELEVENLABS_EGRESS_CHECK?: string
    /** Comma-separated addresses ElevenLabs connects from. */
    ELEVENLABS_EGRESS_IPS?: string
}

type Globals = {
    WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket }
    WebSocketRequestResponsePair?: new (request: string, response: string) => unknown
}
export const runtimeGlobals = () => globalThis as unknown as Globals
