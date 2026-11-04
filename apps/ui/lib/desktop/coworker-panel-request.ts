import type { DesktopCoworkerPanel } from './coworker-panel'

/** A transient navigation request; chat/tab identity and persistence stay independent. */
export type DesktopCoworkerPanelRequest = { agentId: string; panel: DesktopCoworkerPanel; nonce: number }
