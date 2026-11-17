// A Node stand-in for the parts of the Workers runtime the relay uses: WebSocketPair, Durable Object
// state and storage, hibernation (a fresh object instance over the same sockets and storage), alarms
// and the 101 upgrade response. Frames are delivered asynchronously and in order; `settle()` waits for them.
import worker, { relayClock, VoiceRelay, type Env } from '../src/index.ts'
import type { RelaySocket, RelayState } from '../src/runtime.ts'

type Owner = { object: () => VoiceRelay; enqueue: (work: () => unknown) => void }

export class FakeSocket implements RelaySocket {
    peer!: FakeSocket
    owner?: Owner
    attachment: unknown = null
    tags: string[] = []
    autoResponseAt: Date | null = null
    closed: { code: number; reason: string } | null = null
    readonly received: string[] = []
    readonly side: 'client' | 'server'
    private readonly world: FakeWorld
    constructor(side: 'client' | 'server', world: FakeWorld) { this.side = side; this.world = world }

    send(message: string | ArrayBuffer) {
        if (this.closed) throw new Error('closed')
        const peer = this.peer
        this.world.later(() => {
            if (peer.closed) return
            if (peer.side === 'client') return void peer.received.push(message as string)
            if (!peer.owner) return
            if (message === this.world.autoResponse?.[0]) {
                peer.autoResponseAt = new Date(relayClock.now())
                return void this.received.push(this.world.autoResponse[1])
            }
            const owner = peer.owner
            owner.enqueue(() => owner.object().webSocketMessage(peer, message))
        })
    }

    close(code = 1000, reason = '') {
        if (this.closed) return
        this.closed = { code, reason }
        const peer = this.peer
        this.world.later(() => {
            if (peer.side === 'client') { if (!peer.closed) peer.closed = { code, reason }; return }
            if (!peer.owner || peer.closed) { if (!peer.closed) peer.closed = { code, reason }; return }
            const owner = peer.owner
            owner.enqueue(async () => { await owner.object().webSocketClose(peer, code); peer.closed ??= { code, reason } })
        })
    }

    serializeAttachment(value: unknown) { this.attachment = structuredClone(value) }
    deserializeAttachment() { return structuredClone(this.attachment) }
    json() { return this.received.map(frame => JSON.parse(frame)) }
}

class FakeObject {
    readonly sockets: FakeSocket[] = []
    readonly data = new Map<string, unknown>()
    alarmAt: number | null = null
    instance!: VoiceRelay
    private chain: Promise<unknown> = Promise.resolve()
    readonly state: RelayState

    private readonly env: Env
    private readonly world: FakeWorld
    constructor(world: FakeWorld, env: Env) {
        this.env = env
        this.world = world
        const data = this.data
        this.state = {
            storage: {
                get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
                put: async (key, value) => { data.set(key, structuredClone(value)) },
                delete: async key => data.delete(key),
                list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))) as Map<string, T>,
                getAlarm: async () => this.alarmAt,
                setAlarm: async when => { this.alarmAt = when },
            },
            acceptWebSocket: (socket, tags = []) => {
                const fake = socket as FakeSocket
                fake.owner = { object: () => this.instance, enqueue: work => this.enqueue(work) }
                fake.tags = tags
                this.sockets.push(fake)
            },
            getWebSockets: tag => this.sockets.filter(socket => !socket.closed && (tag === undefined || socket.tags.includes(tag))),
            setWebSocketAutoResponse: pair => { world.autoResponse = (pair as { pair: [string, string] }).pair },
            getWebSocketAutoResponseTimestamp: socket => (socket as FakeSocket).autoResponseAt,
        }
        this.hibernate()
    }

    hibernate() { this.instance = new VoiceRelay(this.state, this.env) }
    enqueue(work: () => unknown) {
        const next = this.chain.then(work)
        this.chain = next.catch(() => {})
        this.world.track(next)
    }
}

export class FakeWorld {
    autoResponse?: [string, string]
    private readonly objects = new Map<string, FakeObject>()
    private readonly pending = new Set<Promise<unknown>>()
    readonly env: Env

    constructor(env: Omit<Env, 'VOICE_RELAY'>) {
        const world = this
        this.env = {
            ...env,
            VOICE_RELAY: {
                idFromName: name => name,
                get: id => ({ fetch: async (request: Request) => world.object(String(id)).instance.fetch(request) }),
            },
        }
    }

    object(name: string): FakeObject {
        let found = this.objects.get(name)
        if (!found) { found = new FakeObject(this, this.env); this.objects.set(name, found) }
        return found
    }

    later(work: () => void) { this.track(new Promise<void>(resolve => setImmediate(() => { work(); resolve() }))) }
    track(promise: Promise<unknown>) {
        this.pending.add(promise)
        void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    }
    async settle() {
        for (let round = 0; round < 50 && this.pending.size; round++) await Promise.allSettled([...this.pending])
    }

    fetch(request: Request) { return worker.fetch(request, this.env) }
}

export function installRuntime() {
    const globals = globalThis as Record<string, unknown>
    const NativeResponse = globalThis.Response
    class UpgradeResponse extends NativeResponse {
        webSocket?: FakeSocket
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: FakeSocket }) {
            if (init?.status === 101) {
                super(null, { status: 200 })
                Object.defineProperty(this, 'status', { value: 101 })
                this.webSocket = init.webSocket
            } else super(body, init)
        }
    }
    globals.Response = UpgradeResponse
    globals.WebSocketRequestResponsePair = class { pair: [string, string]; constructor(request: string, response: string) { this.pair = [request, response] } }
    return {
        withWorld(world: FakeWorld) {
            globals.WebSocketPair = class {
                0: FakeSocket
                1: FakeSocket
                constructor() {
                    const client = new FakeSocket('client', world), server = new FakeSocket('server', world)
                    client.peer = server; server.peer = client
                    this[0] = client; this[1] = server
                }
            }
        },
    }
}
