import { z } from 'zod'
import { PROFILE_NAME_MAX } from '@/lib/auth/user-profile'

export const desktopProfileName = z.string().trim().min(1).max(PROFILE_NAME_MAX)
    .refine(value => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
export const desktopProfileSchema = z.strictObject({
    id: z.literal(1),
    displayName: z.string(),
    photoId: z.uuid().nullable(),
})
export type DesktopProfile = z.infer<typeof desktopProfileSchema>

export function desktopProfilePhotoUrl(photoId?: string | null) {
    return photoId ? '/api/desktop/profile/photo?' + new URLSearchParams({ id: photoId }) : null
}
