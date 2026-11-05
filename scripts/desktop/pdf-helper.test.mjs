import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { invokePdfHelper, parsePdfRender, pdfFixture, verifyPdfHelper } from './pdf-helper-probe.mjs'

const supported = process.platform === 'darwin'
const source = fileURLToPath(new URL('../../apps/desktop/native/render-pdf.c', import.meta.url))
let root, binary
before(async () => {
    if (!supported) return
    root = await mkdtemp(join(tmpdir(), 'rerun-pdf-helper-'))
    binary = join(root, 'rerun-render-pdf')
    await promisify(execFile)('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-mmacosx-version-min=12.0', source, '-framework', 'CoreFoundation', '-framework', 'CoreGraphics', '-framework', 'ImageIO', '-o', binary])
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

function samplePixel(png, xFraction = .5, yFraction = .5) {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    assert.equal(png[24], 8, 'eight-bit PNG')
    assert.equal(png[28], 0, 'non-interlaced PNG')
    const channels = { 2: 3, 6: 4 }[png[25]]
    assert(channels, 'RGB or RGBA PNG')
    const chunks = []
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset)
        if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
    }
    const stride = width * channels, data = inflateSync(Buffer.concat(chunks))
    assert.equal(data.length, (stride + 1) * height)
    let previous = Buffer.alloc(stride)
    for (let y = 0; y <= Math.floor(height * yFraction); y++) {
        const row = Buffer.from(data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
        const filter = data[y * (stride + 1)]
        assert(filter <= 4)
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? row[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
            const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
            row[x] = (row[x] + predictor) & 255
        }
        previous = row
    }
    return [...previous.subarray(Math.floor(width * xFraction) * channels, Math.floor(width * xFraction) * channels + 3)]
}

// Standards-compliant revision-2 encryption with an empty user password. Even
// automatically unlocked encrypted documents must be rejected by the helper.
function encryptedPdf() {
    const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
    const md5 = bytes => createHash('md5').update(bytes).digest()
    const rc4 = (key, bytes) => {
        const s = Array.from({ length: 256 }, (_, i) => i)
        let j = 0
        for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]] }
        let i = 0; j = 0
        return Buffer.from([...bytes].map(byte => { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; return byte ^ s[(s[i] + s[j]) & 255] }))
    }
    const owner = rc4(md5(padding).subarray(0, 5), padding), id = Buffer.alloc(16, 7), permissions = Buffer.alloc(4)
    permissions.writeInt32LE(-4)
    const key = md5(Buffer.concat([padding, owner, permissions, id])).subarray(0, 5), user = rc4(key, padding)
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 96] /Resources << >> >>',
        `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`,
    ]
    let pdf = '%PDF-1.4\n'; const offsets = [0]
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(pdf)
}

test('native pages render different real pixels with truthful rotated point/pixel dimensions', { skip: !supported }, async () => {
    await verifyPdfHelper(binary)
    const pdf = pdfFixture([{ width: 72, height: 96, color: '1 0 0' }, { width: 120, height: 60, color: '0 0 1', rotation: 90 }])
    const first = await invokePdfHelper(binary, pdf, ['1', '1'])
    const second = await invokePdfHelper(binary, pdf, ['2', '2'])
    assert.equal(first.code, 0); assert.equal(second.code, 0)
    assert.equal(first.stderr, ''); assert.equal(second.stderr, '')
    const a = parsePdfRender(first.stdout), b = parsePdfRender(second.stdout)
    assert.deepEqual(a.header, { page: 1, pageCount: 2, width: 144, height: 192, pageWidth: 72, pageHeight: 96 })
    assert.deepEqual(b.header, { page: 2, pageCount: 2, width: 240, height: 480, pageWidth: 60, pageHeight: 120 })
    // Sampling only the center misses a smaller page centered within a white
    // high-resolution bitmap. Full-page paint must reach the same outer areas.
    for (const [x, y] of [[.5, .5], [.1, .1], [.9, .9]]) {
        assert.deepEqual(samplePixel(a.png, x, y), [255, 0, 0])
        assert.deepEqual(samplePixel(b.png, x, y), [0, 0, 255])
    }
})

test('large pages clamp to dimension and area budgets instead of refusing ordinary A3 or poster geometry', { skip: !supported }, async () => {
    for (const [width, height] of [[842, 1191], [100000, 100000], [100000, 10]]) {
        const result = await invokePdfHelper(binary, pdfFixture([{ width, height }]), ['1', '2'])
        assert.equal(result.code, 0)
        const parsed = parsePdfRender(result.stdout)
        assert(parsed.header.width <= 4096 && parsed.header.height <= 4096)
        assert(parsed.header.width * parsed.header.height <= 8000000)
        assert.equal(parsed.header.pageWidth, width); assert.equal(parsed.header.pageHeight, height)
    }
})

test('encrypted, truncated, invalid, oversized input and out-of-range page/scale return no PNG or document text', { skip: !supported }, async () => {
    const pdf = pdfFixture()
    for (const [bytes, args] of [
        [encryptedPdf(), ['1']], [Buffer.from('%PDF-1.4\nprivate-document-fragment\n%%EOF'), ['1']],
        [pdf.subarray(0, pdf.length - 7), ['1']], [Buffer.concat([pdf, Buffer.alloc(16 * 1024 * 1024 + 1 - pdf.length, 32)]), ['1']],
        [pdf, ['0']], [pdf, ['2']], [pdf, ['10001']], [pdf, ['../document.pdf']],
        [pdf, ['1', '0.1']], [pdf, ['1', '4']], [pdf, ['1', 'NaN']],
    ]) {
        const result = await invokePdfHelper(binary, bytes, args)
        assert.notEqual(result.code, 0)
        assert.equal(result.stdout.length, 0)
        assert.equal(result.stderr, 'Cannot render PDF page.\n')
    }
})

test('the input byte and page-count bounds admit their supported edge and refuse excessive pages', { skip: !supported }, async () => {
    const pdf = pdfFixture()
    const atLimit = await invokePdfHelper(binary, Buffer.concat([pdf, Buffer.alloc(16 * 1024 * 1024 - pdf.length, 32)]), ['1', '.5'])
    assert.equal(atLimit.code, 0)
    assert.equal(parsePdfRender(atLimit.stdout).header.width, 72)
    const excessive = await invokePdfHelper(binary, pdfFixture(Array.from({ length: 10001 }, () => ({ width: 10, height: 10 }))), ['1'])
    assert.equal(excessive.code, 1)
    assert.equal(excessive.stdout.length, 0)
    assert.equal(excessive.stderr, 'Cannot render PDF page.\n')
})

test('native watchdog exits after its parent dies even while inherited stdin remains open', { skip: !supported, timeout: 6000 }, async () => {
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
        import { spawn } from 'node:child_process';
        const child = spawn(process.argv[1], ['1'], { stdio: ['inherit', 'inherit', 'inherit'], env: { LANG: 'C' } });
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
    `, binary], { stdio: ['pipe', 'pipe', 'pipe'] })
    let helperPid, timer
    const closed = new Promise(resolve => launcher.once('close', resolve))
    try {
        helperPid = await new Promise((resolve, reject) => {
            launcher.once('error', reject)
            launcher.stdout.once('data', chunk => resolve(Number(chunk.toString('utf8').trim())))
        })
        assert(Number.isSafeInteger(helperPid) && helperPid > 1)
        // Let the helper capture its parent and block in read(0); the writable
        // end is owned here and intentionally stays open across launcher death.
        await new Promise(resolve => setTimeout(resolve, 250))
        launcher.kill('SIGKILL')
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Orphan PDF helper kept its output pipe open')), 2000) })])
    } finally {
        clearTimeout(timer)
        launcher.stdin.destroy(); launcher.kill('SIGKILL')
        if (helperPid) { try { process.kill(helperPid, 'SIGKILL') } catch {} }
    }
})

test('native wall-clock alarm bounds incomplete stdin without a parent deadline', { skip: !supported, timeout: 13000 }, async () => {
    const child = spawn(binary, ['1'], { env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let timer
    try {
        const result = await Promise.race([
            new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
            new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native PDF alarm did not fire')) }, 12000) }),
        ])
        assert.equal(result.signal, 'SIGALRM')
    } finally { clearTimeout(timer); child.stdin.destroy(); child.kill('SIGKILL') }
})
