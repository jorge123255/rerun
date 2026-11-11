import { z } from 'zod'

export const DESKTOP_CHANGELOG_URL = 'https://rerun.build/changelog'
export const DESKTOP_CHANGELOG_LIMIT = 10
export const DESKTOP_CHANGELOG_FRESH_MS = 30 * 24 * 60 * 60 * 1000
const imageBase = 'https://sucqmcejnrnvcdnrwhld.supabase.co/storage/v1/object/public/changelog-images/entries/'

export const changelogSlug = z.string().max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const changelogTime = z.iso.datetime()
export const changelogImage = z.string().max(256).refine(value =>
    value.startsWith(imageBase) && /^[\w-]+\.(webp|png|jpe?g|gif|avif)$/i.test(value.slice(imageBase.length)))
export const changelogEntries = z.array(z.object({
    slug: changelogSlug,
    title: z.string().trim().min(1).max(300),
    publishedAt: changelogTime,
    body: z.string().max(12000),
    image: changelogImage.nullable(),
    darkImage: changelogImage.nullable(),
    imageAlt: z.string().max(500),
})).max(DESKTOP_CHANGELOG_LIMIT)
export const changelogSeen = z.object({ slug: changelogSlug, publishedAt: changelogTime }).strict()
export const desktopChangelogFeed = z.object({
    entries: changelogEntries,
    seenAt: changelogTime,
    stale: z.boolean(),
})
export type DesktopChangelogFeed = z.infer<typeof desktopChangelogFeed>
export type DesktopChangelogEntry = DesktopChangelogFeed['entries'][number]
