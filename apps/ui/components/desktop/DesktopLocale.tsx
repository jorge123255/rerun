'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { desktopLocaleTag, desktopTranslator, englishDesktopLanguage, type DesktopLanguage } from '@/lib/desktop/locale'

const LocaleContext = createContext({
    language: englishDesktopLanguage,
    t: desktopTranslator(englishDesktopLanguage),
    setLanguage: (_language: DesktopLanguage) => {},
})

export function DesktopLocale({ initial, children }: { initial: DesktopLanguage; children: ReactNode }) {
    const [language, setLanguage] = useState(initial)
    const tag = desktopLocaleTag(language.locale)
    const value = useMemo(() => ({ language, t: desktopTranslator(language), setLanguage }), [language])
    useEffect(() => {
        const original = document.documentElement.lang
        document.documentElement.lang = tag
        return () => { document.documentElement.lang = original }
    }, [tag])
    return <LocaleContext.Provider value={value}><div className="contents" lang={tag}>{children}</div></LocaleContext.Provider>
}

export const useDesktopLocale = () => useContext(LocaleContext)
