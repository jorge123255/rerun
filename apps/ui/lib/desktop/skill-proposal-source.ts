import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { skillProposalIdOf, stripBridgePrefix } from '@rerun/contracts'

/** Only the tool output that raised a proposal is its source; joined calls create no card. */
export function desktopSkillProposalIds(messages: readonly UIMessage[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) if (message.role === 'assistant') for (const part of message.parts) {
        if (!isToolUIPart(part) || stripBridgePrefix(getToolName(part)) !== 'skill_propose' || part.state !== 'output-available') continue
        const id = skillProposalIdOf(part.output)
        if (id) ids.add(id)
    }
    return ids
}
