'use client'

import type { ExternalMcpKeyView } from '@rerun/contracts'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Loader2Icon } from '@/lib/icons'

export function DesktopRevokeExternalMcpKeyDialog({ apiKey, pending, error, onOpenChange, onConfirm }: { apiKey: ExternalMcpKeyView | null; pending: boolean; error?: string | null; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
    return (
        <AlertDialog open={!!apiKey} onOpenChange={next => { if (!pending) onOpenChange(next) }}>
            <AlertDialogContent size="sm">
                <AlertDialogHeader>
                    <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {apiKey?.name ?? 'This key'} stops working right away, and whatever runs on it loses its hold on the workspace. The key cannot be brought back, but you can create another one.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error && <p role="alert" className="break-words px-6 text-sm text-destructive">{error}</p>}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={pending}
                        onClick={event => {
                            event.preventDefault()
                            onConfirm()
                        }}
                    >
                        {pending && <Loader2Icon className="animate-spin" />}
                        Revoke
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
