'use client'

import { DRAFT_LANGUAGE, DraftBlock } from '@/components/chat/DraftBlock'
import { copyDesktopPlainText } from '@/lib/desktop/clipboard'
import { toast } from 'sonner'
import type { CustomRendererProps, PluginConfig } from 'streamdown'

const copyFailed = () => toast.error('Could not copy this draft. Try again.')

function DesktopDraftBlock(props: CustomRendererProps) {
    return <DraftBlock {...props} writeText={copyDesktopPlainText} onCopyError={copyFailed} />
}

export const desktopDraftPlugins: PluginConfig = {
    renderers: [{ language: DRAFT_LANGUAGE, component: DesktopDraftBlock }],
}
