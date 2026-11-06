import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import { pathEscapesRoot } from './resources.mjs'

const root = resolve(sep, 'stable-resources')

test('resource confinement rejects the parent itself, not only its descendants', () => {
    assert.equal(pathEscapesRoot(root, resolve(root, '..')), true)
    assert.equal(pathEscapesRoot(root, resolve(root, '..', 'outside')), true)
    assert.equal(pathEscapesRoot(root, resolve(root, '..', 'stable-resources-other')), true)
})

test('resource confinement accepts ordinary and nested packaged files', () => {
    assert.equal(pathEscapesRoot(root, root), false)
    assert.equal(pathEscapesRoot(root, resolve(root, 'runtime-manifest.json')), false)
    assert.equal(pathEscapesRoot(root, resolve(root, 'runtime', 'ui', 'server.js')), false)
})

test('resource confinement rejects an absolute different root', () => {
    assert.equal(pathEscapesRoot(root, resolve(sep, 'another-root', 'server.js')), true)
})
