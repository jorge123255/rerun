import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionMainModule } from './production-main.mjs'

test('production main excludes every native test module at any depth', () => {
    assert.equal(productionMainModule('remote-machines/coordinator.test.mjs'), false)
    assert.equal(productionMainModule('workspaces/runtime.test.mjs'), false)
    assert.equal(productionMainModule('index.test.mjs'), false)
})

test('production main excludes test-only fixture adapters without rejecting production modules', () => {
    assert.equal(productionMainModule('remote-machines/fixtures.mjs'), false)
    assert.equal(productionMainModule('remote-machines/network.mjs'), true)
    assert.equal(productionMainModule('remote-machines/coordinator.mjs'), true)
    assert.equal(productionMainModule('workspaces/paths.mjs'), true)
    assert.equal(productionMainModule('index.mjs'), true)
    assert.equal(productionMainModule('preload.cjs'), true)
    assert.equal(productionMainModule('startup.js'), true)
})

test('production main matching handles packaged path separators', () => {
    assert.equal(productionMainModule('remote-machines\\network.test.mjs'), false)
    assert.equal(productionMainModule('remote-machines\\fixtures.mjs'), false)
})
