'use client'

import { createContext, useContext, useMemo, type PropsWithChildren } from 'react'
import { APP_SLUGS, type AppSlug } from '@/cloud/apps'

export type FeatureFlags = { computer: boolean; apps: Partial<Record<AppSlug, boolean>> }

// Tout à `false` par défaut : un composant rendu hors du provider, comme les menus de toolbar
// repris par le kit de marque, tombe du côté masqué sans avoir à le dire.
const FeatureFlagsContext = createContext<FeatureFlags>({ computer: false, apps: {} })

export function FeatureFlagsProvider({ computer, apps, children }: PropsWithChildren<FeatureFlags>) {
    const value = useMemo(() => ({ computer, apps }), [computer, apps])
    return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>
}

export function useComputerEnabled() {
    return useContext(FeatureFlagsContext).computer
}

export function usePaidAppEnabled(slug: AppSlug) {
    return useContext(FeatureFlagsContext).apps[slug] ?? false
}

// The paid apps this workspace can see, in the order the menus list them. The layout hands a fresh
// `apps` object on every router refresh: the list keeps its identity as long as the same apps are
// on, since it sits in the deps of effects that call the server.
export function useEnabledPaidApps(): AppSlug[] {
    const { apps } = useContext(FeatureFlagsContext)
    const key = APP_SLUGS.filter(slug => apps[slug]).join(',')
    return useMemo(() => (key ? (key.split(',') as AppSlug[]) : []), [key])
}
