import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_CHANGELOG_URL } from '@/lib/desktop/changelog'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { parsePublishedChangelog } from '@/lib/desktop/server/changelog-source'
import { GET, PATCH } from './route'

const origin = 'http://127.0.0.1:3123'
const token = 'd'.repeat(48)
const older = '2026-06-01T08:00:00.000Z'
const recent = '2026-06-02T08:00:00.000Z'
const asset = 'https://sucqmcejnrnvcdnrwhld.supabase.co/storage/v1/object/public/changelog-images/entries/synthetic.webp'
const headline = (slug: string, datePublished: string, url = DESKTOP_CHANGELOG_URL + '#' + slug) =>
    ({ '@type': 'CreativeWork', url, datePublished, headline: slug, image: asset })
const page = () => `<script type="application/ld+json">${JSON.stringify({
    '@type': 'CollectionPage', url: DESKTOP_CHANGELOG_URL, hasPart: [
        headline('older', older), headline('recent', recent),
        headline('foreign', recent, 'https://other.invalid/changelog#foreign'),
        headline('future', '2099-05-09T00:00:00Z'),
    ],
})}</script>
<article id="recent"><img src="${asset}" alt="Synthetic preview"><img src="https://other.invalid/tracking.png" class="dark:block">
  <h2>Recent</h2><p>New <a href="javascript:void(0)">feature</a>.</p>
  <p>Preserve &amp; read.</p><ul><li><p>First item</p></li></ul><script>ignore source</script>
</article>`

let root: string
const request = (method = 'GET', data?: unknown, authenticated = true) => new Request(origin + '/api/desktop/changelog', {
    method, headers: { host: new URL(origin).host, origin, ...(authenticated && { cookie: 'rerun-desktop-session=' + token }) },
    body: data === undefined ? undefined : JSON.stringify(data),
})
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-changelog-'))
    const runtime = join(root, 'runtime.json')
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_INSTALL_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '1')
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', runtime)
    await writeFile(runtime, JSON.stringify({
        protocolVersion: 1, launchNonce: 'test', buildId: 'test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' },
    }), { mode: 0o600 })
    await (await openDesktopDatabase(root)).execute("UPDATE desktop_profile SET created_at = '2026-05-31T00:00:00.000Z' WHERE id = 1")
})
afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

test('reads only published entries from the official structured catalogue and extracts inert text', () => {
    const entries = parsePublishedChangelog(page())
    expect(entries.map(entry => entry.slug)).toEqual(['recent', 'older'])
    expect(entries[0]).toMatchObject({ body: 'New feature.\n\nPreserve & read.\n\n• First item', image: asset, darkImage: null, imageAlt: 'Synthetic preview' })
    expect(() => parsePublishedChangelog('<article>Wrong page</article>')).toThrow('Missing Rerun changelog catalogue')
})

test('requires desktop authority and persists the exact latest acknowledgement through reopen', async () => {
    const fetcher = vi.fn(async () => new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    vi.stubGlobal('fetch', fetcher)
    expect((await GET(request('GET', undefined, false))).status).toBe(401)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await (await GET(request())).json()).toMatchObject({ seenAt: '2026-05-31T00:00:00.000Z', stale: false })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(DESKTOP_CHANGELOG_URL, expect.objectContaining({ redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html' } }))
    expect((await PATCH(request('PATCH', { slug: 'unseen', publishedAt: recent }))).status).toBe(409)
    expect((await PATCH(request('PATCH', { slug: 'recent', publishedAt: recent }, false))).status).toBe(401)
    expect(await (await PATCH(request('PATCH', { slug: 'recent', publishedAt: recent }))).json()).toEqual({ seenAt: recent })
    expect(await (await PATCH(request('PATCH', { slug: 'older', publishedAt: older }))).json()).toEqual({ seenAt: recent })
    await closeDesktopDatabase(root)
    expect(await (await GET(request())).json()).toMatchObject({ seenAt: recent, stale: false })
    expect(fetcher).toHaveBeenCalledOnce()
})

test('keeps previously published updates when the site is offline or returns the wrong document', async () => {
    const fetcher = vi.fn(async () => new Response(page(), { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetcher)
    const first = await (await GET(request())).json()
    await (await openDesktopDatabase(root)).execute('UPDATE desktop_changelog SET fetched_at = 0')
    fetcher.mockRejectedValueOnce(new Error('Offline'))
    expect(await (await GET(request())).json()).toEqual({ ...first, stale: true })
    fetcher.mockResolvedValueOnce(new Response('<h1>Temporarily unavailable</h1>', { headers: { 'content-type': 'text/html' } }))
    expect(await (await GET(request())).json()).toEqual({ ...first, stale: true })
})
