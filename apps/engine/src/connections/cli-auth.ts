import type { Provider } from '@rerun/contracts'
import { acquireClaudeLease, ensureFreshClaudeToken } from './claude-token.js'
import { desktopApp } from '../desktop/policy.js'
import { prepareDesktopCodexChat } from '../desktop/codex-login.js'
import { ensureCodexAuth } from './codex-auth.js'
import type { LoadedConnection } from './types.js'

// The CLI providers read their credential off disk or env at spawn time, so a token that lapsed
// since the last call has to be refreshed before the process starts, not by it. The returned
// release is called once that process is gone: until then a Claude refresh would revoke its token.
export async function ensureCliAuth(provider: Provider, connection: LoadedConnection | null): Promise<() => void> {
    if (provider === 'claude') {
        await ensureFreshClaudeToken(connection)
        return acquireClaudeLease(connection)
    }
    if (provider === 'codex') {
        if (desktopApp()) await prepareDesktopCodexChat()
        else await ensureCodexAuth(connection)
    }
    return () => {}
}
