// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { DesktopAppLogo, desktopAppLogoSource } from './DesktopAppLogo'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('only bundled artwork or an https picture is ever loaded', () => {
    expect(desktopAppLogoSource('/services/gmail.svg')).toBe('/services/gmail.svg')
    expect(desktopAppLogoSource('/services/canva.png?tone=light')).toBe('/services/canva.png?tone=light')
    expect(desktopAppLogoSource('https://logos.example.test/slack.png')).toBe('https://logos.example.test/slack.png')
    for (const refused of ['http://logos.example.test/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/api/desktop/vault', '/services/../secret.png', 'https://user:pw@example.test/a.png', '', null, undefined]) {
        expect(desktopAppLogoSource(refused), String(refused)).toBeNull()
    }
})

test('a picture that fails to load gives way to the plain mark', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<DesktopAppLogo logo="/services/gmail.svg" />) })
    const picture = host.querySelector('img')!
    expect(picture.getAttribute('src')).toBe('/services/gmail.svg')
    expect(picture.getAttribute('referrerpolicy')).toBe('no-referrer')
    await act(async () => { picture.dispatchEvent(new Event('error')) })
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()
    await act(async () => { root.render(<DesktopAppLogo logo={null} />) })
    expect(host.querySelector('img')).toBeNull()
    act(() => { root.unmount() })
})
