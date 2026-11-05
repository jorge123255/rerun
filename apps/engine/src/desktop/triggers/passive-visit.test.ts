import { describe, expect, it } from 'vitest'
import { isPassiveVisit } from './passive-visit.js'

describe('isPassiveVisit', () => {
    it('ignores link previews, prefetch and browser navigations', () => {
        expect(isPassiveVisit(new Headers({ 'user-agent': 'Slackbot 1.0' }))).toBe(true)
        expect(isPassiveVisit(new Headers({ 'user-agent': 'Mozilla/5.0', 'sec-purpose': 'prefetch' }))).toBe(true)
        expect(isPassiveVisit(new Headers({ 'user-agent': 'Mozilla/5.0', 'sec-fetch-dest': 'document' }))).toBe(true)
        expect(isPassiveVisit(new Headers({ 'user-agent': 'curl/8.0', 'sec-fetch-dest': 'empty' }))).toBe(false)
        expect(isPassiveVisit(new Headers({ 'user-agent': 'Zapier' }))).toBe(false)
    })
})
