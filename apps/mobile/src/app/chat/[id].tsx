import { FOREMAN_AGENT_ID, ROUTE_ID_PATTERN } from '@rerun/contracts'
import { Redirect, useLocalSearchParams } from 'expo-router'

import { CoworkerChat } from '@/components/chat/CoworkerChat'
import { ForemanChat } from '@/components/chat/ForemanChat'
import { onMac } from '@/config/environment'
import { MacEmptyPane } from '@/mac/MacEmptyPane'

const NEW = 'new'

// `id` is a conversation, `new`, `general` for a coworker's General, or `last` for the Foreman; `to`
// names the coworker, the Foreman when it is left out. Both land in hub paths, so a link with anything
// else in them opens the home instead.
export default function Chat() {
    const { id, to } = useLocalSearchParams<{ id: string; to?: string }>()
    if (!ROUTE_ID_PATTERN.test(id) || (to !== undefined && !ROUTE_ID_PATTERN.test(to))) return <Redirect href="/" />
    const sessionId = id === NEW ? null : id
    // A paired Mac serves its coworkers, not the Foreman: a wide window opens on an empty pane.
    if ((!to || to === FOREMAN_AGENT_ID) && onMac) return <MacEmptyPane />
    if (!to || to === FOREMAN_AGENT_ID) return <ForemanChat sessionId={sessionId} />
    return <CoworkerChat agentId={to} sessionId={sessionId} />
}
