import {useState} from 'react'
import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {FolderIcon} from '@/lib/icons'
import {DesktopControlCenterParityView} from './DesktopControlCenterParityView'
it('mounts the original dialog without unmounting the board/draft and retains Escape close',async()=>{
 const selected=vi.fn()
 function Harness(){const [open,setOpen]=useState(false);return <><input aria-label="Unsent draft" defaultValue="keep this exact draft"/><div data-testid="board" data-camera="original"/><button onClick={()=>setOpen(true)}>Show center</button><DesktopControlCenterParityView open={open} onOpenChange={setOpen} query="" onQueryChange={()=>{}} placeholder="Search" pageKey="root" depth={0} crumbs={[]} onBack={()=>{}} emptyLabel="Nothing matches." mod="⌘" sections={[{id:'open',heading:'Open',rows:[{id:'files',label:'Files',leading:{kind:'icon',icon:FolderIcon},onSelect:selected}]}]}/></>}
 render(<Harness/>);const draft=screen.getByLabelText('Unsent draft'),board=screen.getByTestId('board')
 fireEvent.click(screen.getByText('Show center'))
 await screen.findByRole('dialog')
 fireEvent.keyDown(document.activeElement??document.body,{key:'Escape'})
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
 expect(screen.getByTestId('board')).toBe(board);expect((draft as HTMLInputElement).value).toBe('keep this exact draft');expect(selected).not.toHaveBeenCalled()
})
it('busy/disabled rows cannot invoke actions through click or drill shortcuts',async()=>{
 const select=vi.fn(),drill=vi.fn()
 const view=render(<DesktopControlCenterParityView busy open onOpenChange={()=>{}} query="" onQueryChange={()=>{}} placeholder="Search" pageKey="agent:a" depth={1} crumbs={['Agent']} onBack={()=>{}} emptyLabel="Nothing matches." mod="⌘" sections={[{id:'open',heading:'Open',rows:[{id:'files',label:'Files',leading:{kind:'icon',icon:FolderIcon},onSelect:select,onDrill:drill}]}]}/>)
 fireEvent.click(screen.getByText('Files'))
 fireEvent.keyDown(screen.getByPlaceholderText('Search'),{key:'Tab'})
 expect(select).not.toHaveBeenCalled();expect(drill).not.toHaveBeenCalled();view.unmount()
})
