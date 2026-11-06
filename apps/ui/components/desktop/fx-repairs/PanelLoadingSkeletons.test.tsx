import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { FxFilesLoading, FxMemoriesLoading, FxSettingsLoading, FxSchedulesLoading, FxToolsLoading } from './PanelLoadingSkeletons'
test('five real original skeleton compositions remain accessible, inert and non-interactive', () => {
    for (const view of [<FxFilesLoading />, <FxMemoriesLoading />, <FxSettingsLoading />, <FxSchedulesLoading />, <FxToolsLoading />]) {
        const html = renderToStaticMarkup(view)
        expect(html).toContain('role="status"'); expect(html).toContain('aria-busy="true"'); expect(html).toContain('aria-hidden="true"')
        expect(html).toContain('motion-reduce:animate-none'); expect(html).not.toMatch(/<(button|input|textarea|select)\b/)
    }
    expect(renderToStaticMarkup(<FxMemoriesLoading searching />)).toContain('Searching memories…')
    expect(renderToStaticMarkup(<FxFilesLoading />).match(/size-16/g)).toHaveLength(10)
    expect(renderToStaticMarkup(<FxToolsLoading />)).toContain('minmax(0, 1fr)')
})
