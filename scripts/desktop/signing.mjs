import { output } from './lib.mjs'

export function choosePreviewSigningIdentity(listing, requested) {
    const identities = [...listing.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]+)"\s*$/gm)]
        .map(([, hash, name]) => ({ hash: hash.toUpperCase(), name,
            type: /^(Apple Development|Mac Developer):/.test(name) ? 'development' : 'distribution' }))
        .filter(({ name }) => /^(Developer ID Application|Apple Development|Mac Developer):/.test(name))
    if (requested) {
        const selected = identities.filter(row => row.hash === requested.toUpperCase() || row.name === requested)
        if (selected.length !== 1) throw new Error('The requested preview signing identity is not uniquely available in the Mac Keychain.')
        return selected[0]
    }
    const distribution = identities.filter(row => row.type === 'distribution')
    const candidates = distribution.length ? distribution : identities
    if (candidates.length !== 1) throw new Error(candidates.length
        ? 'More than one preview signing identity is available. Set RERUN_DESKTOP_SIGN_IDENTITY to the intended certificate name or SHA-1.'
        : 'No stable Mac signing identity is available. Add a development signing certificate before rebuilding the preview; ad-hoc updates repeatedly request Keychain access.')
    return candidates[0]
}

export async function previewSigningArguments() {
    const identity = choosePreviewSigningIdentity(await output('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']), process.env.RERUN_DESKTOP_SIGN_IDENTITY)
    console.log(`Using stable ${identity.type} signing for the local preview.`)
    return [`-c.mac.identity=${identity.hash}`, `-c.mac.type=${identity.type}`, '-c.forceCodeSigning=true', '-c.mac.notarize=false']
}
