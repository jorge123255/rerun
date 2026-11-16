import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { RerunCloudRow } from './LocalMachineRow'

it('offers the hosted workspace from Servers and says it is separate', () => {
    const open = vi.fn()
    render(<RerunCloudRow onOpen={open} />)
    expect(screen.getByText('Rerun Cloud')).toBeTruthy()
    expect(screen.getByText(/nothing is shared with this Mac/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledOnce()
})
