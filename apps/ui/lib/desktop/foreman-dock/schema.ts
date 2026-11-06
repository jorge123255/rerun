import { z } from 'zod'

/** Additive field on the existing saved UI snapshot; no new persistence store. */
export const desktopForemanDockExtrasSchema = z.strictObject({
    orbCorner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    sheetDetent: z.enum(['medium', 'large']).nullable(),
})
