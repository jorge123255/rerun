import { create } from 'zustand'
import type { AddonKey } from '@/cloud/billing'

type BillingState = {
    open: boolean
    highlightAddon: AddonKey | null
    // What surfaced the paywall (trial_pill, budget_exhausted, entitlement_gate, …), for `paywall_viewed`.
    trigger: string | null
    // Ouvre le dialog billing, optionnellement en mettant un add-on en avant (ex. depuis un feature gate).
    openBilling: (highlight?: AddonKey, trigger?: string) => void
    setOpen: (open: boolean) => void
}

export const useBillingStore = create<BillingState>(set => ({
    open: false,
    highlightAddon: null,
    trigger: null,
    openBilling: (highlight, trigger) => set({ open: true, highlightAddon: highlight ?? null, trigger: trigger ?? 'manual' }),
    // Reset du highlight à la fermeture pour ne pas le retrouver à la réouverture via le menu.
    setOpen: open => set(open ? { open } : { open: false, highlightAddon: null, trigger: null }),
}))
