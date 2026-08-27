import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UNITS_OF_MEASURE, type Item } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FormField } from '@/features/auth/FormField';
import { useCreateItem, useUpdateItem } from './api';
import { emptyItemForm, itemFormSchema, itemToForm, formToInput, type ItemFormValues } from './itemForm';

interface ItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present means edit, absent means create. */
  item?: Item | undefined;
  /**
   * Prefill for a new item. Its one caller is the scanner, handing back the code
   * that resolved to nothing so nobody has to read it off the label and retype
   * it — which is exactly the transcription error the scanner exists to avoid.
   * Ignored when editing, where the item is the truth.
   */
  defaults?: Partial<ItemFormValues> | undefined;
  onSaved?: (item: Item) => void;
}

export function ItemDialog({ open, onOpenChange, item, defaults, onSaved }: ItemDialogProps) {
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();
  const isEdit = Boolean(item);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ItemFormValues>({
    resolver: zodResolver(itemFormSchema),
    defaultValues: emptyItemForm,
  });

  // Read through a ref rather than depended on: callers pass an object literal,
  // and a new identity every render would reset the form under the typist.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  // Reset on open so a previously edited item's values never leak into the
  // next dialog the user opens.
  useEffect(() => {
    if (open) reset(item ? itemToForm(item) : { ...emptyItemForm, ...defaultsRef.current });
  }, [open, item, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const input = formToInput(values);
    try {
      const saved = item
        ? await updateItem.mutateAsync({ id: item.id, input })
        : await createItem.mutateAsync(input);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.fields) {
        for (const [field, message] of Object.entries(error.fields)) {
          if (field in emptyItemForm) setError(field as keyof ItemFormValues, { message });
        }
        return;
      }
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Could not save this item',
      });
    }
  });

  const unitOfMeasure = watch('unitOfMeasure');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit item' : 'New item'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Changes apply immediately. Stock levels are unaffected.'
              : 'Define a SKU. Stock is added later through a receipt.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="SKU"
              autoFocus={!isEdit}
              placeholder="BOLT-M6-30"
              error={errors.sku?.message}
              {...register('sku')}
            />
            <FormField
              label="Name"
              placeholder="Hex bolt M6 x 30mm"
              error={errors.name?.message}
              {...register('name')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Category"
              placeholder="Fasteners"
              error={errors.category?.message}
              {...register('category')}
            />
            <div className="grid gap-1.5">
              <Label htmlFor="unitOfMeasure">Unit of measure</Label>
              <Select
                value={unitOfMeasure}
                onValueChange={(value) =>
                  setValue('unitOfMeasure', value as ItemFormValues['unitOfMeasure'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger id="unitOfMeasure">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS_OF_MEASURE.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Unit cost"
              type="number"
              step="0.01"
              min="0"
              hint="What you pay, per unit."
              error={errors.unitCost?.message}
              {...register('unitCost')}
            />
            <FormField
              label="Unit price"
              type="number"
              step="0.01"
              min="0"
              hint="What you charge, per unit."
              error={errors.unitPrice?.message}
              {...register('unitPrice')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Reorder point"
              type="number"
              min="0"
              hint="Reorder when on-hand drops to this."
              error={errors.reorderPoint?.message}
              {...register('reorderPoint')}
            />
            <FormField
              label="Reorder quantity"
              type="number"
              min="0"
              hint="How many to order each time."
              error={errors.reorderQuantity?.message}
              {...register('reorderQuantity')}
            />
          </div>

          <FormField label="Barcode" error={errors.barcode?.message} {...register('barcode')} />
          <FormField
            label="Description"
            error={errors.description?.message}
            {...register('description')}
          />

          {errors.root && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errors.root.message}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
