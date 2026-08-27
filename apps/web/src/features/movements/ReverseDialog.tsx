import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { isReversible, TRANSFER_REVERSAL_MESSAGE, type Movement } from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/features/auth/FormField';
import { formatMovementDate } from '@/lib/dates';
import { FormError } from './FormParts';
import { applyServerErrors } from './formErrors';
import { reverseFormSchema, type ReverseFormValues } from './movementForms';
import { balanceSentence, reversedSentence } from './summaries';
import { useReverseMovement } from './api';

interface ReverseDialogProps {
  /** The movement being undone. Null while the dialog is closed. */
  movement: Movement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Undo a movement by appending its opposite.
 *
 * Deliberately not an edit and not a delete. The original row stays exactly
 * where it was and a second row cancels it, which is the only way a stock
 * ledger's history stays true — so the wording here says "appends", not
 * "removes", because that is what somebody will find when they look.
 */
export function ReverseDialog({ movement, open, onOpenChange }: ReverseDialogProps) {
  const reverse = useReverseMovement();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ReverseFormValues>({
    resolver: zodResolver(reverseFormSchema),
    defaultValues: { note: '' },
  });

  // A note typed against one movement must never ride along to the next.
  useEffect(() => {
    if (open) reset({ note: '' });
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    if (!movement) return;
    try {
      const result = await reverse.mutateAsync({ id: movement.id, input: { note: values.note } });
      toast.success(
        reversedSentence({
          quantity: movement.quantity,
          sku: movement.itemSku,
          locationCode: movement.locationCode,
        }),
        { description: balanceSentence(result.movement.locationCode, result.balanceAfter) },
      );
      onOpenChange(false);
    } catch (error) {
      applyServerErrors(error, setError, [], 'Could not reverse this movement');
    }
  });

  const blocked = movement !== null && !isReversible(movement.type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse this movement?</DialogTitle>
          <DialogDescription>
            The original stays on the record. A second movement is appended that cancels it, so the
            history shows both what happened and that it was corrected.
          </DialogDescription>
        </DialogHeader>

        {movement && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <dt className="text-muted-foreground">When</dt>
            <dd>{formatMovementDate(movement.occurredAt)}</dd>
            <dt className="text-muted-foreground">Item</dt>
            <dd className="tabular">
              {movement.itemSku} <span className="text-muted-foreground">{movement.itemName}</span>
            </dd>
            <dt className="text-muted-foreground">Bin</dt>
            <dd className="tabular">{movement.locationCode}</dd>
            <dt className="text-muted-foreground">Quantity</dt>
            <dd className="tabular">
              {movement.quantity > 0 ? '+' : ''}
              {movement.quantity.toLocaleString()}
            </dd>
            <dt className="text-muted-foreground">Who</dt>
            <dd>{movement.actorName}</dd>
          </dl>
        )}

        {blocked ? (
          <>
            <FormError message={TRANSFER_REVERSAL_MESSAGE} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <FormField
              label="Note"
              // Focus moves into the dialog on open, per the ARIA dialog
              // pattern - not a page grabbing focus on load, which is what
              // no-autofocus exists to stop. The note is the only thing being
              // asked for here.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              placeholder="Counted twice"
              hint="Why it was wrong. This is what the next person reads."
              error={errors.note?.message}
              {...register('note')}
            />

            {errors.root && (
              <FormError message={errors.root.message ?? 'That did not go through'} />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Reversing...' : 'Reverse movement'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
