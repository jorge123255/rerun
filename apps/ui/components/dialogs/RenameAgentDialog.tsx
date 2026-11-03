'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

const AGENT_NAME_MAX = 60

const schema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(AGENT_NAME_MAX, `Keep it under ${AGENT_NAME_MAX} characters`),
})

type FormValues = z.infer<typeof schema>

export function RenameAgentDialog({ agent, open, onOpenChange, onRename, onRestoreFocus }: {
    agent: { id: string; name: string } | undefined
    open: boolean
    onOpenChange: (open: boolean) => void
    onRename: (id: string, name: string) => void | Promise<void>
    onRestoreFocus?: () => void
}) {
    const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: agent?.name ?? '' } })

    useEffect(() => {
        if (open) form.reset({ name: agent?.name ?? '' })
    }, [open, agent?.name, form])

    const onSubmit = form.handleSubmit(async values => {
        const name = values.name.trim()
        try {
            if (agent && name !== agent.name) await onRename(agent.id, name)
            onOpenChange(false)
        } catch (error) {
            form.setError('name', { message: error instanceof Error ? error.message : 'Could not rename this coworker.' }, { shouldFocus: true })
        }
    })

    return (
        <Dialog open={open} onOpenChange={next => { if (!form.formState.isSubmitting) onOpenChange(next) }}>
            <DialogContent className="sm:max-w-md" onCloseAutoFocus={onRestoreFocus ? event => {
                event.preventDefault()
                onRestoreFocus()
            } : undefined}>
                <Form {...form}>
                    <form onSubmit={onSubmit} className="flex flex-col gap-4">
                        <DialogHeader>
                            <DialogTitle>Rename coworker</DialogTitle>
                            <DialogDescription>The name shown on the board and in chats. Its @handle follows.</DialogDescription>
                        </DialogHeader>

                        <FormField
                            control={form.control}
                            name="name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormControl>
                                        <Input label="Name" required autoFocus readOnly={form.formState.isSubmitting} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <DialogFooter>
                            <Button type="button" variant="outline" disabled={form.formState.isSubmitting} onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || !form.watch('name').trim()}>
                                Rename
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    )
}
