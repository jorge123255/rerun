// Known codexErrorInfo object kind that the provider already lists (httpConnectionFailed).
import { createInterface } from 'node:readline'

const THREAD_ID = 'thread-known'
const TURN_ID = 'turn-known'
const failure = {
    message: 'Upstream HTTP connection failed while talking to Codex.',
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
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
        send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn('failed', failure) } })
    }
})
