import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopSelectedMentionText } from './DesktopSelectedMentionText'

test('only the explicitly selected occurrence keeps the original coworker token styling',()=>{
    const text='@ada then @ada',metadata={coworkerMentions:[{targetId:'local-original',token:'@ada',start:0,end:4}]}
    const html=renderToStaticMarkup(<DesktopSelectedMentionText text={text} metadata={metadata}/>)
    expect(html.match(/text-violet-700/g)).toHaveLength(1)
    expect(html).toContain('</span> then @ada')
    expect(html).not.toContain('local-original')
    expect(renderToStaticMarkup(<DesktopSelectedMentionText text={text} metadata={{}}/>)).toBe('<span>@ada then @ada</span>')
})

test('shortens a bare HTTPS link without changing its target or absorbing its punctuation and keeps unsafe URLs literal', () => {
    const url = 'https://example.com/work/brief?revision=42#notes'
    const unsafe = 'https://user:pass@example.com/hidden http://example.com/plain file:///tmp/example javascript:alert(1)'
    const text = `@ada see (${url}). @ada ${unsafe}`
    const html = renderToStaticMarkup(<DesktopSelectedMentionText text={text}
        metadata={{ coworkerMentions: [{ targetId: 'local-original', token: '@ada', start: 0, end: 4 }] }} />)
    expect(html.match(/text-violet-700/g)).toHaveLength(1)
    expect(html.match(/href=/g)).toHaveLength(1)
    expect(html).toContain(`href="${url}" target="_blank" rel="noopener noreferrer"`)
    expect(html).toContain('example.com/…/brief…')
    expect(html).toContain(`</a>). @ada ${unsafe}`)
})
