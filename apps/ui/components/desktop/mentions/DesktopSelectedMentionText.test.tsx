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
