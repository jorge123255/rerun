/** Codex initialize may wait 120s for a Keychain prompt, then login/start another 30s. */
export const DESKTOP_CODEX_LOGIN_BUDGET_MS = 160_000

export function desktopCodexStartSignal(): AbortSignal {
    return AbortSignal.timeout(DESKTOP_CODEX_LOGIN_BUDGET_MS)
}
