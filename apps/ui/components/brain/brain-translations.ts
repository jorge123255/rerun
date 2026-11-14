'use client'

import english from '@rerun/i18n/messages/en/brain.json'
import { createContext, useContext } from 'react'
import { createTranslator } from 'use-intl/core'

export function createBrainTranslator(locale: string, messages: typeof english) {
    return createTranslator({ locale, messages })
}

export const BrainTranslations = createContext(createBrainTranslator('en', english))
export const useBrainTranslations = () => useContext(BrainTranslations)
