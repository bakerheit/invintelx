import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { Item, Location } from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import { FormField } from '@/features/auth/FormField';
import { useItemStock } from '@/features/items/api';
import { FormCard, FormError, NegativeStockNotice, PostedResult } from './FormParts';
import { ItemScanner } from './ItemScanner';
import { BinPicker, ItemPicker } from './pickers';
import { applyServerErrors } from './formErrors';
import { emptyTransferForm, transferFormSchema, type TransferFormValues } from './movementForms';
import { quantityError, toQuantity } from './quantity';
import { balanceSentence, transferredSentence } from './summaries';
import { negativeStockWarning, onHandAt } from './warnings';
import { useTransfer, type PostedTransfer } from './api';

const SERVER_FIELDS = ['itemId', 'fromLocationId', 'toLocationId', 'quantity'];

/**
 * Move stock between two bins.
 *
 * Written by the ledger as a pair in one transaction, so both balances come back
 * and both are shown — a transfer that only reports one end is how somebody ends
 * up believing stock arrived somewhere it did not.
 */
export function TransferForm() {
  const [item, setItem] = useState<Item | null>(null);
  const [from, setFrom] = useState<Location | null>(null);
  const [to, setTo] = useState<Location | null>(null);
  const [posted, setPosted] = useState<PostedTransfer | null>(null);

  const transfer = useTransfer();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<TransferFormValues>({
    resolver: zodResolver(transferFormSchema),
    defaultValues: emptyTransferForm,
  });

  const stock = useItemStock(item?.id ?? '', item !== null);

  const rawQuantity = watch('quantity');
  const warning =
    from && stock.data && quantityError(rawQuantity) === null
      ? negativeStockWarning({
          locationCode: from.code,
          onHand: onHandAt(stock.data.byLocation, from.id),
          delta: -toQuantity(rawQuantity),
        })
      : null;

  const chooseItem = (next: Item | null) => {
    setItem(next);
    setValue('itemId', next?.id ?? '', { shouldValidate: Boolean(next) });
  };

  const chooseFrom = (next: Location | null) => {
    setFrom(next);
    setValue('fromLocationId', next?.id ?? '', { shouldValidate: Boolean(next) });
  };

  const chooseTo = (next: Location | null) => {
    setTo(next);
    // Validated even when cleared: "pick two different bins" hangs off this
    // field, and the message has to clear along with the choice that caused it.
    setValue('toLocationId', next?.id ?? '', { shouldValidate: Boolean(next) });
  };

  /** See the notes in MoveForm: cleared on every attempt, not only the ones that resolve. */
  const scanStarted = () => setValue('quantity', '');

  const scanned = (next: Item) => {
    chooseItem(next);
    setFocus('quantity');
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await transfer.mutateAsync({
        itemId: values.itemId,
        fromLocationId: values.fromLocationId,
        toLocationId: values.toLocationId,
        quantity: toQuantity(values.quantity),
        reference: values.reference,
        note: values.note,
      });
      setPosted(result);
      toast.success(
        transferredSentence({
          quantity: Math.abs(result.out.quantity),
          sku: result.out.itemSku,
          fromCode: result.out.locationCode,
          toCode: result.in.locationCode,
        }),
      );
      reset({
        ...emptyTransferForm,
        itemId: values.itemId,
        fromLocationId: values.fromLocationId,
        toLocationId: values.toLocationId,
      });
    } catch (error) {
      setPosted(null);
      applyServerErrors(error, setError, SERVER_FIELDS, 'Could not move this stock');
    }
  });

  return (
    <FormCard title="Transfer" description="Move stock from one bin to another. Total on hand does not change.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <ItemScanner onItem={scanned} onScanStart={scanStarted} />

        <ItemPicker value={item} onChange={chooseItem} error={errors.itemId?.message} />

        <div className="grid gap-4 sm:grid-cols-2">
          <BinPicker
            label="From bin"
            value={from}
            onChange={chooseFrom}
            error={errors.fromLocationId?.message}
          />
          <BinPicker
            label="To bin"
            value={to}
            onChange={chooseTo}
            error={errors.toLocationId?.message}
          />
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
            hint="A move ticket, a replenishment run."
            error={errors.reference?.message}
            {...register('reference')}
          />
        </div>

        <FormField label="Note" error={errors.note?.message} {...register('note')} />

        {warning && <NegativeStockNotice message={warning} />}
        {errors.root && <FormError message={errors.root.message ?? 'That did not go through'} />}

        {posted && (
          <PostedResult
            summary={transferredSentence({
              quantity: Math.abs(posted.out.quantity),
              sku: posted.out.itemSku,
              fromCode: posted.out.locationCode,
              toCode: posted.in.locationCode,
            })}
            balances={[
              balanceSentence(posted.out.locationCode, posted.fromBalance),
              balanceSentence(posted.in.locationCode, posted.toBalance),
            ]}
          />
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Moving...' : 'Move stock'}
          </Button>
        </div>
      </form>
    </FormCard>
  );
}
