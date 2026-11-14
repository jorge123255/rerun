import { execFile } from 'node:child_process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { atomicPrivateJSON, readJSON } from '../workspaces/paths.mjs'
import { ensurePairingDir, pairingDir } from './store.mjs'

const exec = promisify(execFile)

export function isPrivateAddress(address) {
    if (!isIPv4(address)) return false
    const [first, second] = address.split('.').map(Number)
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

export function localPairingAddresses() {
    return [...new Set(Object.values(networkInterfaces()).flat()
        .filter(entry => entry && !entry.internal && isPrivateAddress(entry.address)).map(entry => entry.address))].sort()
}

function parseIdentity(identity, host) {
    const certificate = new X509Certificate(identity.cert)
    if (!certificate.checkPrivateKey(createPrivateKey(identity.key)) || certificate.checkIP(host) !== host
        || !certificate.verify(certificate.publicKey)) throw new Error('The local network identity could not be verified.')
    if (!(Date.parse(certificate.validFrom) <= Date.now() && Date.now() < Date.parse(certificate.validTo))) {
        throw new Error('The local network identity expired. Choose the network address again to create a new identity.')
    }
    return { key: identity.key, cert: identity.cert, certificateFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase() }
}

export async function loadLanIdentity(dataRoot, host, { renew = false } = {}) {
    if (!isPrivateAddress(host)) throw new Error('Choose a private IPv4 address assigned to this Mac.')
    const path = join(pairingDir(dataRoot), `lan-${host}.json`)
    try {
        const identity = await readJSON(path)
        try { return parseIdentity(identity, host) }
        catch (error) { if (!renew) throw error }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    if (!renew) throw new Error('The local network identity is missing.')
    await ensurePairingDir(dataRoot)
    const scratch = await mkdtemp(join(pairingDir(dataRoot), 'certificate-'))
    try {
        const config = join(scratch, 'request.cnf')
        await writeFile(config, '[req]\nprompt = no\ndistinguished_name = subject\n[subject]\nCN = Rerun Local Pairing\n', { flag: 'wx', mode: 0o600 })
        await exec('/usr/bin/openssl', [
            'req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
            '-pkeyopt', 'ec_param_enc:named_curve',
            '-nodes', '-sha256', '-days', '397', '-config', config,
            '-addext', `subjectAltName=IP:${host}`, '-addext', 'basicConstraints=critical,CA:FALSE',
            '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=serverAuth',
            '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'),
        ], { env: { PATH: '/usr/bin:/bin' }, timeout: 5000, maxBuffer: 32_768 })
        const identity = { key: await readFile(join(scratch, 'key.pem'), 'utf8'), cert: await readFile(join(scratch, 'cert.pem'), 'utf8') }
        const verified = parseIdentity(identity, host)
        await atomicPrivateJSON(path, identity)
        return verified
    } finally {
        await rm(scratch, { recursive: true, force: true })
    }
}
