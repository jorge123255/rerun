import { stripBridgePrefix } from '@rerun/contracts'
import type { UIMessageChunk } from 'ai'
import { projectDesktopToolStatus } from '@/components/desktop/tool-presentations/status'
import { DESKTOP_FOREMAN_LIVE_REPLY_LIMIT, DESKTOP_FOREMAN_LIVE_STEP_LIMIT, desktopForemanLiveToolSchema,
    type DesktopForemanLiveReply, type DesktopForemanLiveStep } from '../../foreman/live-reply'

export function createForemanReplyPreview(runId: string) {
    let started = false
    let text = ''
    let textPart: string | null = null
    let writingPart: string | null = null
    const steps = new Map<string, DesktopForemanLiveStep>()
    const clear = () => { text = ''; textPart = null; writingPart = null; steps.clear() }
    const finishStep = (id: string, status: 'done' | 'error') => {
        const step = steps.get(id)
        if (step?.status === 'running') steps.set(id, { ...step, status })
    }
    return {
        get writing() { return !!writingPart },
        read(): DesktopForemanLiveReply | null {
            if (!text.trim() && !steps.size) return null
            return { runId, text, ...(steps.size && { steps: [...steps.values()] }) }
        },
        accept(chunk: UIMessageChunk) {
            if (chunk.type === 'start') {
                clear()
                started = chunk.messageId === runId
                return
            }
            if (!started) return
            switch (chunk.type) {
                case 'text-delta': {
                    if (chunk.delta.trim()) writingPart = chunk.id
                    const separator = textPart !== null && textPart !== chunk.id ? '\n\n' : ''
                    const remaining = DESKTOP_FOREMAN_LIVE_REPLY_LIMIT - text.length
                    if (remaining > 0) text += (separator + chunk.delta).slice(0, remaining)
                    textPart = chunk.id
                    break
                }
                case 'text-end':
                    if (writingPart === chunk.id) writingPart = null
                    break
                case 'tool-input-start':
                case 'tool-input-available':
                case 'tool-input-error': {
                    writingPart = null
                    const id = chunk.toolCallId
                    const tool = desktopForemanLiveToolSchema.safeParse(stripBridgePrefix(chunk.toolName))
                    if (!tool.success || !id || id.length > 256) break
                    const previous = steps.get(id)
                    if (previous && previous.tool !== tool.data) break
                    if (!previous && steps.size < DESKTOP_FOREMAN_LIVE_STEP_LIMIT) {
                        steps.set(id, { tool: tool.data, offset: text.length, status: 'running' })
                    }
                    if (chunk.type === 'tool-input-error') finishStep(id, 'error')
                    break
                }
                case 'tool-output-available':
                    if (!chunk.preliminary && steps.has(chunk.toolCallId)) {
                        const status = projectDesktopToolStatus({ state: chunk.type, output: chunk.output })
                        finishStep(chunk.toolCallId, status === 'failed' ? 'error' : 'done')
                    }
                    break
                case 'tool-output-error':
                case 'tool-output-denied':
                    finishStep(chunk.toolCallId, 'error')
                    break
                case 'reasoning-start':
                case 'finish-step':
                case 'finish':
                    writingPart = null
                    break
                case 'abort':
                case 'error':
                    started = false
                    clear()
                    break
            }
        },
    }
}
