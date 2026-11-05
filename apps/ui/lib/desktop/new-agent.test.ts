import { describe, expect, it, vi } from 'vitest'
import { EMPTY_READING } from '@rerun/ui/new-agent/reading'
import {
    DESKTOP_JOB_READ_BYTES, DESKTOP_NEW_AGENT_CAPABILITIES, IDLE_CREATION, createDesktopJobReader, desktopCreationIntent,
    requestDesktopCreation, settleDesktopCreation, type DesktopCreateState, type DesktopCreationIntent,
} from './new-agent'

const TEXT = 'Read every new support ticket and draft a reply for the ones about billing.'

const reading = (patch: Record<string, unknown> = {}) => ({ name: 'Billing Replies', apps: [], schedule: null, ...patch })

const intentOf = (patch: Record<string, unknown> = {}, capabilities = DESKTOP_NEW_AGENT_CAPABILITIES): DesktopCreationIntent => {
    const built = desktopCreationIntent({ text: TEXT, reading: reading(), capabilities, ...patch }, 'request-1')
    if (!('intent' in built)) throw new Error(`refused: ${built.refusal}`)
    return built.intent
}

describe('desktopCreationIntent', () => {
    it('sends the description exactly as typed, trimmed, and names the coworker', () => {
        expect(intentOf()).toEqual({
            requestId: 'request-1',
            name: 'Billing Replies',
            kickoff: TEXT,
            suggestionId: null,
            scheduled: false,
        })
        expect(intentOf({ text: `  ${TEXT}\n\n` }).kickoff).toBe(TEXT)
    })

    it('prefers the name typed in the pill over the one read in the description', () => {
        expect(intentOf({ pinnedName: '  Ledger  ' }).name).toBe('Ledger')
        expect(intentOf({ pinnedName: 'x'.repeat(80) }).name).toHaveLength(60)
    })

    it('falls back to the first words of the job when nothing reads a name', () => {
        const built = desktopCreationIntent({ text: TEXT, reading: EMPTY_READING, capabilities: DESKTOP_NEW_AGENT_CAPABILITIES }, 'request-2')
        expect('intent' in built && built.intent.name).toBe('Read every new support ticket')
    })

    it('refuses an empty description and one past the server bound', () => {
        expect(desktopCreationIntent({ text: '   ' }, 'r')).toEqual({ refusal: 'empty' })
        expect(desktopCreationIntent({ text: 'x'.repeat(2001) }, 'r')).toEqual({ refusal: 'too-long' })
    })

    it('never adds a schedule instruction this host cannot honour, and reports a described timing only where it can', () => {
        const described = reading({ schedule: { label: 'Every weekday at 9:00', source: 'every weekday' } })
        expect(intentOf({ reading: described, schedule: { kind: 'preset', id: 'weekday' } }).kickoff).toBe(TEXT)
        expect(intentOf({ reading: described }).scheduled).toBe(false)

        const hosted = { apps: true, templates: true, schedule: true }
        expect(intentOf({ reading: described }, hosted).scheduled).toBe(true)
        expect(intentOf({ reading: described, schedule: { kind: 'preset', id: 'weekday' } }, hosted).kickoff).toBe(`${TEXT}\n\nRun this every weekday at 9:00. Set up the schedule yourself.`)
        expect(intentOf({ reading: EMPTY_READING, schedule: { kind: 'on-demand' } }, hosted).kickoff).toBe(`${TEXT}\n\nDo not set up any schedule: only run this when I ask.`)
        expect(intentOf({ reading: EMPTY_READING, schedule: { kind: 'on-demand' } }, hosted).scheduled).toBe(false)
    })
})

describe('creation state machine', () => {
    const start = (patch: Record<string, unknown> = {}) => {
        const requested = requestDesktopCreation(IDLE_CREATION, { text: TEXT, reading: reading(), ...patch }, () => 'request-1')
        if (!requested.intent) throw new Error('expected an intent')
        return requested
    }

    it('ignores a second press while one creation is on its way', () => {
        const requested = start()
        expect(requested.state.status).toBe('pending')
        const again = requestDesktopCreation(requested.state, { text: TEXT, reading: reading() }, () => 'request-2')
        expect(again.intent).toBeNull()
        expect(again.refusal).toBe('in-flight')
        expect(again.state).toBe(requested.state)
    })

    it('resumes the same intent, with the same request id, after an uncertain creation', () => {
        const requested = start()
        const uncertain = settleDesktopCreation(requested.state, { kind: 'uncertain', error: 'gateway' })
        expect(uncertain).toMatchObject({ status: 'uncertain', error: 'gateway' })
        const resumed = requestDesktopCreation(uncertain, { text: TEXT, reading: reading() }, () => 'request-2')
        expect(resumed.intent?.requestId).toBe('request-1')
        expect(resumed.intent).toEqual(requested.intent)
        expect(resumed.state).toMatchObject({ status: 'pending' })
    })

    it('gives a definite refusal a fresh attempt, and a created one nothing left to resume', () => {
        const requested = start()
        expect(settleDesktopCreation(requested.state, { kind: 'refused', error: 'A coworker named X exists' })).toEqual(IDLE_CREATION)
        expect(settleDesktopCreation(requested.state, { kind: 'created' })).toEqual(IDLE_CREATION)
        const retried = requestDesktopCreation(IDLE_CREATION, { text: TEXT, reading: reading() }, () => 'request-2')
        expect(retried.intent?.requestId).toBe('request-2')
    })

    it('stays idle when a stray outcome arrives with nothing pending', () => {
        const idle: DesktopCreateState = { status: 'idle' }
        expect(settleDesktopCreation(idle, { kind: 'uncertain', error: 'late' })).toBe(idle)
    })
})

describe('createDesktopJobReader', () => {
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    it('reads the name the connected provider suggests, through the one bounded route', async () => {
        const fetchImpl = vi.fn(async () => reply({ reply: '{"name":"Billing Replies","apps":["gmail"],"schedule":null}' }))
        const reading = await createDesktopJobReader({ fetchImpl }).read(TEXT)
        expect(reading).toEqual({ name: 'Billing Replies', apps: [], schedule: null })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('/api/desktop/new-agent/read')
        expect(init).toMatchObject({ method: 'POST', cache: 'no-store' })
        expect(JSON.parse(String(init.body))).toEqual({ text: TEXT })
        expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('reads nothing at all under the length the hosted dialog also skips', async () => {
        const fetchImpl = vi.fn()
        expect(await createDesktopJobReader({ fetchImpl }).read('too short')).toEqual(EMPTY_READING)
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('falls back honestly when the model, the route or the reply is unavailable', async () => {
        expect(await createDesktopJobReader({ fetchImpl: vi.fn(async () => reply({ error: 'no model' }, 503)) }).read(TEXT)).toEqual(EMPTY_READING)
        expect(await createDesktopJobReader({ fetchImpl: vi.fn(async () => reply({ reply: 'not json at all' })) }).read(TEXT)).toEqual(EMPTY_READING)
        expect(await createDesktopJobReader({ fetchImpl: vi.fn(async () => { throw new Error('offline') }) }).read(TEXT)).toEqual(EMPTY_READING)
        expect(await createDesktopJobReader({ fetchImpl: vi.fn(async () => reply({ reading: { name: 'Wrong shape' } })) }).read(TEXT)).toEqual(EMPTY_READING)
    })

    it('gives up on a slow read instead of holding the dialog', async () => {
        const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }))
        expect(await createDesktopJobReader({ fetchImpl, timeoutMs: 5 }).read(TEXT)).toEqual(EMPTY_READING)
    })

    it('discards a replaced read even when fetch ignores abort and resolves late', async () => {
        const signals: AbortSignal[] = []
        const finishes: ((response: Response) => void)[] = []
        const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            signals.push(init!.signal!)
            return new Promise<Response>(resolve => { finishes.push(resolve) })
        })
        const reader = createDesktopJobReader({ fetchImpl })
        const first = reader.read('A first description that is long enough')
        const second = reader.read('A second description that is long enough')
        expect(await first).toEqual(EMPTY_READING)
        finishes[1](reply({ reply: '{"name":"Current"}' }))
        expect(await second).toEqual({ name: 'Current', apps: [], schedule: null })
        const late = reply({ reply: '{"name":"Old name"}' })
        finishes[0](late)
        await Promise.resolve()
        expect(late.bodyUsed).toBe(true)
        expect(signals).toHaveLength(2)
        expect(signals[0].aborted).toBe(true)
        expect(signals[1].aborted).toBe(false)
    })

    it('shortening below the readable minimum cancels the previous request immediately', async () => {
        let finish!: (response: Response) => void
        let signal!: AbortSignal
        const reader = createDesktopJobReader({ fetchImpl: vi.fn((_input, init) => {
            signal = init!.signal!
            return new Promise<Response>(resolve => { finish = resolve })
        }) })
        const first = reader.read(TEXT)
        expect(await reader.read('tiny')).toEqual(EMPTY_READING)
        expect(signal.aborted).toBe(true)
        expect(await first).toEqual(EMPTY_READING)
        finish(reply({ reply: '{"name":"Old"}' }))
    })

    it('enforces its deadline when fetch never responds to abort', async () => {
        vi.useFakeTimers()
        try {
            const reader = createDesktopJobReader({ timeoutMs: 50, fetchImpl: vi.fn(() => new Promise<Response>(() => {})) })
            const pending = reader.read(TEXT)
            await vi.advanceTimersByTimeAsync(50)
            expect(await pending).toEqual(EMPTY_READING)
        } finally { vi.useRealTimers() }
    })

    it('cancels a stalled body and will not parse a late name after cancel', async () => {
        const cancel = vi.fn()
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"reply":')) }, cancel })
        const reader = createDesktopJobReader({ fetchImpl: vi.fn(async () => new Response(body)) })
        const pending = reader.read(TEXT)
        await Promise.resolve()
        await Promise.resolve()
        reader.cancel()
        expect(await pending).toEqual(EMPTY_READING)
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('caps actual streamed response bytes even without a Content-Length header', async () => {
        const cancel = vi.fn()
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new Uint8Array(DESKTOP_JOB_READ_BYTES + 1).fill(32))
        }, cancel }))
        const reader = createDesktopJobReader({ fetchImpl: vi.fn(async () => response) })
        expect(await reader.read(TEXT)).toEqual(EMPTY_READING)
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('rejects an advertised oversized response before reading and releases it', async () => {
        const cancel = vi.fn()
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': String(DESKTOP_JOB_READ_BYTES + 1) } })
        const reader = createDesktopJobReader({ fetchImpl: vi.fn(async () => response) })
        expect(await reader.read(TEXT)).toEqual(EMPTY_READING)
        expect(cancel).toHaveBeenCalledTimes(1)
    })
})
