// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { DesktopTemplateFidelityReview } from './DesktopTemplateFidelityReview'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true
test('binary entries are inert and missing setup is visible without account activation', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    try {
        await act(async () => root.render(<DesktopTemplateFidelityReview coworkers={[{agentKey:'c00',name:'Fixture',envKeys:['TOKEN'],mcpAuth:[],requirements:[{kind:'environment-key',name:'TOKEN'}],files:[{path:'workspace/active.html',bytes:12,kind:'binary',binary:true,textScanned:false,mediaType:'text/html',sourceRevision:'a'.repeat(64),flagged:[]}]}]} />))
        expect(host.textContent).toContain('No preview'); expect(host.textContent).toContain('To provide again on a copy')
        expect(host.querySelector('iframe,object,embed,img,script')).toBeNull(); expect(host.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()) }
})
