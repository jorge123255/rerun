'use client'

import english from '@rerun/i18n/messages/en/notifications.json'
import { createContext, useContext } from 'react'
import { createTranslator } from 'use-intl/core'

type PeekMessages = typeof english.inbox.peek

// Upstream reads these strings with next-intl, which this tree does not carry. The peek card takes
// them from a context instead, as the brain and file screens do: English by default, the Mac's
// language when `DesktopLocale` provides it.
export function createPeekTranslator(locale: string, messages: PeekMessages) {
    return createTranslator({ locale, messages })
}

export const PeekTranslations = createContext(createPeekTranslator('en', english.inbox.peek))
export const usePeekTranslations = () => useContext(PeekTranslations)
