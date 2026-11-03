// The engine (often remote/self-hosted) must reach the UI over the public internet to
// call the Hub (POST /api/hub), so this MUST be an absolute public URL, never a relative
// path. Also baked into engine cloud-init as RERUN_HUB_BASE_URL and used for public
// publish links.
export function hubBaseUrl(): string {
    const explicit = process.env.RERUN_HUB_BASE_URL
    if (explicit) return explicit.replace(/\/$/, '')
    const publicUrl = process.env.NEXT_PUBLIC_APP_URL
    if (publicUrl) return publicUrl.replace(/\/$/, '')
    // Dev fallback: the UI dev server runs on :3050 (see package.json `dev`). In any
    // real deployment set RERUN_HUB_BASE_URL — the engine must reach this from its host.
    return 'http://localhost:3050'
}
