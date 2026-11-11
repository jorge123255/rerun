'use client'

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CheckIcon, ChevronsUpDownIcon } from '@/lib/icons'
import { useMemo, useState } from 'react'

function timezones(): string[] {
    const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    return supported ? supported('timeZone') : ['UTC']
}

export function TimezoneCombobox({ value, onChange, placeholder = 'Select timezone', searchPlaceholder = 'Search timezone…', emptyLabel = 'No timezone found' }: {
    value: string; onChange: (tz: string) => void; placeholder?: string; searchPlaceholder?: string; emptyLabel?: string
}) {
    const [open, setOpen] = useState(false)
    const zones = useMemo(() => timezones(), [])

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm transition-colors hover:bg-muted aria-expanded:bg-muted"
                >
                    <span className={value ? '' : 'text-muted-foreground'}>{value || placeholder}</span>
                    <ChevronsUpDownIcon className="size-3.5 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
                <Command>
                    <CommandInput placeholder={searchPlaceholder} className="h-8 text-sm" />
                    <CommandList>
                        <CommandEmpty>{emptyLabel}</CommandEmpty>
                        <CommandGroup>
                            {zones.map(tz => (
                                <CommandItem
                                    key={tz}
                                    value={tz}
                                    onSelect={() => {
                                        onChange(tz)
                                        setOpen(false)
                                    }}
                                >
                                    <span className="flex-1">{tz}</span>
                                    {value === tz && <CheckIcon className="size-3.5" />}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    )
}
