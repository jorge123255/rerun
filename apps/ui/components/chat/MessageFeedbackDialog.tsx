'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MESSAGE_FEEDBACK_CATEGORIES, MESSAGE_FEEDBACK_CATEGORY_VALUES, type MessageFeedbackCategory, type MessageFeedbackRating } from '@rerun/contracts'
import { Loader2Icon } from '@/lib/icons'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

const schema = z.object({
    category: z.enum(MESSAGE_FEEDBACK_CATEGORY_VALUES).optional(),
    details: z.string().max(5_000),
})

type FormValues = z.infer<typeof schema>

export type MessageFeedbackDetails = { category: MessageFeedbackCategory | null; details: string }

const SHARED_NOTICE = 'Submitting this report shares this conversation with the Rerun team so we can improve your coworkers.'

type MessageFeedbackDialogProps = {
    open: boolean
    rating: MessageFeedbackRating
    onOpenChange: (open: boolean) => void
    // Resolves to whether the details were saved, which is what closes the dialog.
    onSubmit: (details: MessageFeedbackDetails) => Promise<boolean>
    notice?: string
}

export function MessageFeedbackDialog({ open, rating, onOpenChange, onSubmit, notice = SHARED_NOTICE }: MessageFeedbackDialogProps) {
    const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { category: undefined, details: '' } })
    const {
        formState: { isSubmitting },
    } = form

    useEffect(() => {
        if (open) form.reset({ category: undefined, details: '' })
    }, [open, form])

    const negative = rating === 'down'

    const submit = form.handleSubmit(async ({ category, details }) => {
        if (await onSubmit({ category: negative ? (category ?? null) : null, details })) onOpenChange(false)
    })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <Form {...form}>
                    <form onSubmit={submit} className="flex flex-col gap-4">
                        <DialogHeader>
                            <DialogTitle>{negative ? 'Give negative feedback' : 'Give positive feedback'}</DialogTitle>
                        </DialogHeader>
                        {negative && (
                            <FormField
                                control={form.control}
                                name="category"
                                render={({ field }) => (
                                    <FormItem>
                                        <Field label="What type of issue do you wish to report?" optional>
                                            <Select value={field.value} onValueChange={field.onChange}>
                                                <FormControl>
                                                    <SelectTrigger className="w-full">
                                                        <SelectValue placeholder="Select…" />
                                                    </SelectTrigger>
                                                </FormControl>
                                                <SelectContent>
                                                    {MESSAGE_FEEDBACK_CATEGORIES.map(category => (
                                                        <SelectItem key={category.value} value={category.value}>
                                                            {category.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </Field>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        )}
                        <FormField
                            control={form.control}
                            name="details"
                            render={({ field }) => (
                                <FormItem>
                                    <Field label="Please provide details" optional>
                                        <FormControl>
                                            <Textarea autoFocus={!negative} placeholder={negative ? 'What was unsatisfying about this response?' : 'What was satisfying about this response?'} className="min-h-24" {...field} />
                                        </FormControl>
                                    </Field>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <p className="text-xs text-muted-foreground">{notice}</p>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting}>
                                {isSubmitting && <Loader2Icon className="size-4 animate-spin" />}
                                Submit
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    )
}
