'use client'

import { BrainTranslations, createBrainTranslator } from '@/components/brain/brain-translations'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { desktopLocaleTag, desktopTranslator, englishDesktopLanguage, type DesktopLanguage } from '@/lib/desktop/locale'

const LocaleContext = createContext<{
    language: DesktopLanguage
    t: ReturnType<typeof desktopTranslator>
    setLanguage: (language: DesktopLanguage) => void
}>({
    language: englishDesktopLanguage,
    t: desktopTranslator(englishDesktopLanguage),
    setLanguage: () => {},
})

export function DesktopLocale({ initial, children }: { initial: DesktopLanguage; children: ReactNode }) {
    const [language, setLanguage] = useState(initial)
    const tag = desktopLocaleTag(language.locale)
    const brain = useMemo(() => createBrainTranslator(tag, language.messages.brain), [tag, language.messages.brain])
    const value = useMemo(() => ({ language, t: desktopTranslator(language), setLanguage }), [language])
    useEffect(() => {
        const original = document.documentElement.lang
        document.documentElement.lang = tag
        return () => { document.documentElement.lang = original }
    }, [tag])
    return (
        <LocaleContext.Provider value={value}>
            <BrainTranslations.Provider value={brain}>
                <div className="contents" lang={tag}>{children}</div>
            </BrainTranslations.Provider>
        </LocaleContext.Provider>
    )
}

export const useDesktopLocale = () => useContext(LocaleContext)
