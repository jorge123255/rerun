import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { macTarget } from './mac-target.mjs'

export function macProviderBinaries(engineRoot) {
    const { platform, codexTriple } = macTarget()
    const engine = createRequire(join(engineRoot, 'package.json'))
    const codexAdapter = createRequire(engine.resolve('ai-sdk-provider-codex-cli'))
    const codex = createRequire(codexAdapter.resolve('@openai/codex/package.json'))
    const codexRoot = dirname(codex.resolve(`@openai/codex-${platform}/package.json`))
    const claudeAdapter = createRequire(engine.resolve('ai-sdk-provider-claude-code'))
    const claude = createRequire(claudeAdapter.resolve('@anthropic-ai/claude-agent-sdk'))
    const claudeRoot = dirname(claude.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`))
    return { codexBin: join(codexRoot, 'vendor', codexTriple, 'bin'), claudeRoot }
}
