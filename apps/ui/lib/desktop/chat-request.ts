// A saved conversation can open in a new tab. An open-tab request selects its exact existing
// UID, including an unsent conversation, and must never create a replacement tab.
export type DesktopChatRequest = { id: string } | { tabUid: string; sessionId: string | null }
