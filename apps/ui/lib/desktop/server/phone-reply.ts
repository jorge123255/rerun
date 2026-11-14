import 'server-only'
import { parseJsonEventStream, uiMessageChunkSchema } from 'ai'

const previewLimit = 200_000

export function phoneReplyStream(body: ReadableStream<Uint8Array>, runId: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let started = false
    let part: string | undefined
    let length = 0
    return parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema }).pipeThrough(new TransformStream({
        transform(result, output) {
            if (!result.success) return
            const chunk = result.value
            if (chunk.type === 'start') {
                started = chunk.messageId === runId
                part = undefined
                if (started) output.enqueue(encoder.encode('{"reset":true}\n'))
                return
            }
            if (!started || chunk.type !== 'text-delta' || !chunk.delta) return
            const separator = part !== undefined && part !== chunk.id ? '\n\n' : ''
            const text = (separator + chunk.delta).slice(0, previewLimit - length)
            part = chunk.id
            length += text.length
            for (let offset = 0; offset < text.length; offset += 4096) {
                output.enqueue(encoder.encode(JSON.stringify({ delta: text.slice(offset, offset + 4096) }) + '\n'))
            }
        },
    }))
}
