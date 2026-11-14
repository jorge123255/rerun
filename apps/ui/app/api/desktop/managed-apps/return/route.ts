export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Where the browser lands after signing in to an app. It carries nothing and changes nothing:
// the Vault asks Composio itself whether the sign-in finished, so anything in the address is ignored.
export function GET() {
    const page = '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Rerun</title>'
        + '<body style="font:16px -apple-system,sans-serif;margin:15vh auto;max-width:28rem;text-align:center">'
        + '<h1 style="font-size:1.25rem">You can go back to Rerun</h1><p>Press “Check sign-in” next to the app in the Vault.</p></body>'
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } })
}
