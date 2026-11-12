import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayedImageTarget, verifiedImageKind } from '../src/main/displayed-image.mjs'

const page = 'http://127.0.0.1:51329/desktop'
const target = src => displayedImageTarget(page, src)

test('board image routes keep the displayed raster path and its available version evidence', () => {
    assert.deepEqual(target('http://127.0.0.1:51329/api/desktop/agents/local-owner/files/image?path=reports%2Fchart+one.png&animation=1&workspaceOwner=engine-owner'), {
        kind: 'coworker', agentId: 'local-owner', path: 'reports/chart one.png', name: 'chart one.png', raster: 'png',
    })
    assert.deepEqual(target('http://127.0.0.1:51329/api/desktop/shared-files/media?path=reports%2Fteam.png'), {
        kind: 'shared', path: 'reports/team.png', name: 'team.png', raster: 'png',
    })
    assert.deepEqual(target('http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=photo.jpg&identity=12%3A34&revision=2026-01-02T03%3A04%3A05.000Z'), {
        kind: 'coworker', agentId: 'alice', path: 'photo.jpg', name: 'photo.jpg', raster: 'jpeg', identity: '12:34', revision: '2026-01-02T03:04:05.000Z',
    })
    assert.equal(target('http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=shot.jpeg').raster, 'jpeg')
    assert.equal(target('http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=shot.gif').raster, 'gif')
    assert.equal(target('http://127.0.0.1:51329/api/desktop/shared-files/media?path=shot.webp&animation=1').raster, 'webp')
})

test('stale, foreign, re-encoded, and unversioned image sources are not save targets', () => {
    const version = 'ab'.repeat(32)
    for (const src of [
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=diagram.svg&animation=1',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=icon.ico',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=picture.avif',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=picture.bmp',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=../secret.png',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=.hidden.png',
        'http://evil.test/api/desktop/agents/alice/files/image?path=a.png',
        'blob:http://127.0.0.1:51329/11111111-1111-1111-1111-111111111111',
        'data:image/png;base64,AAAA',
        'file:///tmp/a.png',
        `http://127.0.0.1:51329/api/desktop/agents/alice/files/download?path=a.png&version=${version}`,
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=a.png&animation=0',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=a.png&path=b.png',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=a.png&download=1',
        'http://user:pass@127.0.0.1:51329/api/desktop/agents/alice/files/image?path=a.png',
        'http://127.0.0.1:51329/api/desktop/agents/alice/files/image?path=a.png#frag',
        'http://127.0.0.1:51329/api/desktop/coworkers/alice/document-attachments?view=preview&sha256=' + version,
        'http://127.0.0.1:51329/api/desktop/foreman/document-attachments?view=preview',
        'http://127.0.0.1:9/api/desktop/agents/alice/files/image?path=a.png',
    ]) assert.equal(target(src), null, src)
    assert.equal(verifiedImageKind(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'png')
    assert.equal(verifiedImageKind(Uint8Array.of(0xff, 0xd8, 0xff)), 'jpeg')
    assert.equal(verifiedImageKind(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'gif')
    const webp = new Uint8Array(12)
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    assert.equal(verifiedImageKind(webp), 'webp')
    assert.equal(verifiedImageKind(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)), null)
})
