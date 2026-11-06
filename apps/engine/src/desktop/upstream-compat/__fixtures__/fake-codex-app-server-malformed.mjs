// Malformed error notification: missing message, object-shaped unknown kind. Must not hang the run
// once root composes the unknown-errorInfo passthrough.
import { createInterface } from 'node:readline'

const THREAD_ID = 'thread-malformed'
const TURN_ID = 'turn-malformed'
const failure = {
    message: 'Malformed Codex error notification with an object-shaped unknown kind.',
    codexErrorInfo: { unexpectedFutureKind: { code: 'x', detail: 1 } },
    additionalDetails: { note: 'fixture' },
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
        send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn('failed', failure) } })
    }
})
