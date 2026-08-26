import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ADJUSTMENT_REASONS, type Item, type Location } from '@invintelx/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/features/auth/FormField';
import { useItemStock } from '@/features/items/api';
import { FormCard, FormError, NegativeStockNotice, PostedResult } from './FormParts';
import { BinPicker, ItemPicker } from './pickers';
import { applyServerErrors } from './formErrors';
import {
  ADJUST_DIRECTION_LABEL,
  ADJUST_DIRECTIONS,
  adjustFormSchema,
  emptyAdjustForm,
  type AdjustFormValues,
} from './movementForms';
import { quantityError, signedAdjustment, toQuantity } from './quantity';
import { adjustedSentence, balanceSentence } from './summaries';
import { negativeStockWarning, onHandAt } from './warnings';
import { useAdjust, type PostedMovement } from './api';

const SERVER_FIELDS = ['itemId', 'locationId', 'quantity', 'reason'];

/**
 * Write stock on or off, against a reason from the fixed list.
 *
 * Direction is a dropdown rather than a minus sign, because "-3" typed as "3" is
 * an adjustment that moves stock the wrong way and reads as deliberate.
 */
export function AdjustForm() {
  const [item, setItem] = useState<Item | null>(null);
  const [bin, setBin] = useState<Location | null>(null);
  const [posted, setPosted] = useState<PostedMovement | null>(null);

  const adjust = useAdjust();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<AdjustFormValues>({
    resolver: zodResolver(adjustFormSchema),
    defaultValues: emptyAdjustForm,
  });

  const stock = useItemStock(item?.id ?? '', item !== null);

  const direction = watch('direction');
  const reason = watch('reason');
  const rawQuantity = watch('quantity');

  const warning =
    bin && stock.data && quantityError(rawQuantity) === null
      ? negativeStockWarning({
          locationCode: bin.code,
          onHand: onHandAt(stock.data.byLocation, bin.id),
          delta: signedAdjustment(direction, toQuantity(rawQuantity)),
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
    try {
      const result = await adjust.mutateAsync({
        itemId: values.itemId,
        locationId: values.locationId,
        quantity: signedAdjustment(values.direction, toQuantity(values.quantity)),
        reason: values.reason,
        note: values.note,
      });
      setPosted(result);
      toast.success(
        adjustedSentence({
          signedQuantity: result.movement.quantity,
          sku: result.movement.itemSku,
          locationCode: result.movement.locationCode,
          reason: result.movement.reason ?? values.reason,
        }),
      );
      reset({
        ...emptyAdjustForm,
        itemId: values.itemId,
        locationId: values.locationId,
        direction: values.direction,
        reason: values.reason,
      });
    } catch (error) {
      setPosted(null);
      applyServerErrors(error, setError, SERVER_FIELDS, 'Could not adjust this stock');
    }
  });

  return (
    <FormCard
      title="Adjust"
      description="Correct what the shelf says against what the ledger says, with a reason that can be totalled later."
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <ItemPicker value={item} onChange={chooseItem} error={errors.itemId?.message} />
          <BinPicker value={bin} onChange={chooseBin} error={errors.locationId?.message} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="direction">Direction</Label>
            <Select
              value={direction}
              onValueChange={(value) =>
                setValue('direction', value as AdjustFormValues['direction'], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger id="direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUST_DIRECTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ADJUST_DIRECTION_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <FormField
            label="Quantity"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            placeholder="0"
            hint="How many units, not the sign."
            error={errors.quantity?.message}
            {...register('quantity')}
          />

          <div className="grid gap-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) =>
                setValue('reason', value as AdjustFormValues['reason'], { shouldValidate: true })
              }
            >
              <SelectTrigger id="reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_REASONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <FormField
          label="Note"
          hint="What happened. The reason code is for counting; this is for the person who reads it later."
          error={errors.note?.message}
          {...register('note')}
        />

        {warning && <NegativeStockNotice message={warning} />}
        {errors.root && <FormError message={errors.root.message ?? 'That did not go through'} />}

        {posted && (
          <PostedResult
            summary={adjustedSentence({
              signedQuantity: posted.movement.quantity,
              sku: posted.movement.itemSku,
              locationCode: posted.movement.locationCode,
              reason: posted.movement.reason ?? '',
            })}
            balances={[balanceSentence(posted.movement.locationCode, posted.balanceAfter)]}
          />
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Adjusting...' : 'Adjust stock'}
          </Button>
        </div>
      </form>
    </FormCard>
  );
}
