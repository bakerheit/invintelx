import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { Item, Location } from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import { FormField } from '@/features/auth/FormField';
import { useItemStock } from '@/features/items/api';
import { FormCard, FormError, NegativeStockNotice, PostedResult } from './FormParts';
import { BinPicker, ItemPicker } from './pickers';
import { applyServerErrors } from './formErrors';
import { emptyMoveForm, moveFormSchema, type MoveFormValues } from './movementForms';
import { quantityError, toQuantity } from './quantity';
import { balanceSentence, postedSentence } from './summaries';
import { negativeStockWarning, onHandAt } from './warnings';
import { useIssue, useReceive, type PostedMovement } from './api';

/** The words that differ between booking stock in and taking it out. */
const COPY = {
  receive: {
    title: 'Receive',
    description: 'Book stock in against a bin — a delivery, a return, a production run.',
    submit: 'Receive stock',
    pending: 'Receiving...',
    verb: 'Received',
    preposition: 'into',
    referenceHint: 'A delivery note, a PO line — whatever this came in on.',
  },
  issue: {
    title: 'Issue',
    description: 'Take stock out — a pick, a despatch, a consumption.',
    submit: 'Issue stock',
    pending: 'Issuing...',
    verb: 'Issued',
    preposition: 'from',
    referenceHint: 'An order number, a job, a cost centre.',
  },
} as const;

const SERVER_FIELDS = ['itemId', 'locationId', 'quantity'];

/**
 * Receive and issue are one form.
 *
 * They take the same five fields and differ only in which way the quantity goes,
 * so writing them twice would be two places for the direction to drift.
 */
export function MoveForm({ kind }: { kind: 'receive' | 'issue' }) {
  const copy = COPY[kind];
  const [item, setItem] = useState<Item | null>(null);
  const [bin, setBin] = useState<Location | null>(null);
  const [posted, setPosted] = useState<PostedMovement | null>(null);

  const receive = useReceive();
  const issue = useIssue();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<MoveFormValues>({
    resolver: zodResolver(moveFormSchema),
    defaultValues: emptyMoveForm,
  });

  // Only asked for once an item is chosen; before that there is no balance to
  // warn about and the request would be a 404 on an empty id.
  const stock = useItemStock(item?.id ?? '', item !== null);

  const rawQuantity = watch('quantity');
  const warning =
    kind === 'issue' && bin && stock.data && quantityError(rawQuantity) === null
      ? negativeStockWarning({
          locationCode: bin.code,
          onHand: onHandAt(stock.data.byLocation, bin.id),
          delta: -toQuantity(rawQuantity),
        })
      : null;

  const chooseItem = (next: Item | null) => {
    setItem(next);
    setValue('itemId', next?.id ?? '', { shouldValidate: Boolean(next) });
  };

  const chooseBin = (next: Location | null) => {
    setBin(next);
    setValue('locationId', next?.id ?? '', { shouldValidate: Boolean(next) });
  };

  const onSubmit = handleSubmit(async (values) => {
    const input = {
      itemId: values.itemId,
      locationId: values.locationId,
      quantity: toQuantity(values.quantity),
      reference: values.reference,
      note: values.note,
    };

    try {
      const result =
        kind === 'receive' ? await receive.mutateAsync(input) : await issue.mutateAsync(input);
      setPosted(result);
      toast.success(
        postedSentence({
          verb: copy.verb,
          quantity: Math.abs(result.movement.quantity),
          sku: result.movement.itemSku,
          preposition: copy.preposition,
          locationCode: result.movement.locationCode,
        }),
      );
      // The item and bin stay put: posting several movements against the same
      // SKU in a row is the normal shape of a goods-in session.
      reset({ ...emptyMoveForm, itemId: values.itemId, locationId: values.locationId });
    } catch (error) {
      setPosted(null);
      applyServerErrors(error, setError, SERVER_FIELDS, `Could not ${kind} this stock`);
    }
  });

  return (
    <FormCard title={copy.title} description={copy.description}>
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <ItemPicker value={item} onChange={chooseItem} error={errors.itemId?.message} />
          <BinPicker value={bin} onChange={chooseBin} error={errors.locationId?.message} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Quantity"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            placeholder="0"
            error={errors.quantity?.message}
            {...register('quantity')}
          />
          <FormField
            label="Reference"
            hint={copy.referenceHint}
            error={errors.reference?.message}
            {...register('reference')}
          />
        </div>

        <FormField label="Note" error={errors.note?.message} {...register('note')} />

        {warning && <NegativeStockNotice message={warning} />}
        {errors.root && <FormError message={errors.root.message ?? 'That did not go through'} />}

        {posted && (
          <PostedResult
            summary={postedSentence({
              verb: copy.verb,
              quantity: Math.abs(posted.movement.quantity),
              sku: posted.movement.itemSku,
              preposition: copy.preposition,
              locationCode: posted.movement.locationCode,
            })}
            balances={[balanceSentence(posted.movement.locationCode, posted.balanceAfter)]}
          />
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? copy.pending : copy.submit}
          </Button>
        </div>
      </form>
    </FormCard>
  );
}
