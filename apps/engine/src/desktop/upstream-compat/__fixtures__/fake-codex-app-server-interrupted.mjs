// Emits an unknown string errorInfo, then turn/completed interrupted, then a replayed turn/started
// for the same turn id — the provider must surface the first terminal error, not hang.
import { createInterface } from 'node:readline'

const THREAD_ID = 'thread-interrupted'
const TURN_ID = 'turn-interrupted'
const failure = {
    message: 'Turn interrupted by an unknown Codex kind.',
    codexErrorInfo: 'turnInterruptedByClient',
    additionalDetails: null,
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const turn = (status, error) => ({ id: TURN_ID, items: [], status, error })

createInterface({ input: process.stdin }).on('line', line => {
    const { id, method } = JSON.parse(line)
    if (method === 'initialize') send({ id, result: { userAgent: 'codex_cli_rs/0.166.0', capabilities: {} } })
    if (method === 'thread/start' || method === 'thread/resume') send({ id, result: { thread: { id: THREAD_ID } } })
    if (method === 'turn/start') {
        send({ id, result: { turn: turn('inProgress', null) } })
        send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: turn('inProgress', null) } })
        send({ method: 'error', params: { error: failure, willRetry: false, threadId: THREAD_ID, turnId: TURN_ID } })
        send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn('interrupted', failure) } })
        send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: turn('inProgress', null) } })
    }
})
