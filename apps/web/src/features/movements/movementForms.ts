import { z } from 'zod';
import { adjustmentReasonSchema, objectIdSchema } from '@invintelx/shared';
import { quantityError, type AdjustDirection } from './quantity';

/**
 * The form contracts for the movement screens.
 *
 * They are not the API's input schemas and are not meant to be. A form holds
 * text from a keyboard and a direction chosen from a dropdown; the wire holds
 * ids and a signed number. Keeping the quantity as text right up to submit is
 * what lets "3.5" be told apart from 3 — the same reason the item form keeps
 * money as a decimal and converts at the boundary.
 */

/** Chosen through a picker, so an empty string means "nothing chosen yet". */
function pickedId(message: string) {
  return z.string().min(1, message).pipe(objectIdSchema);
}

const quantityField = z.string().superRefine((raw, ctx) => {
  const message = quantityError(raw);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

const referenceField = z.string().trim().max(120, 'At most 120 characters');
const noteField = z.string().trim().max(500, 'At most 500 characters');

/** Receipts and issues take the same fields; only the direction differs. */
export const moveFormSchema = z.object({
  itemId: pickedId('Pick an item'),
  locationId: pickedId('Pick a bin'),
  quantity: quantityField,
  reference: referenceField,
  note: noteField,
});
export type MoveFormValues = z.infer<typeof moveFormSchema>;

export const emptyMoveForm: MoveFormValues = {
  itemId: '',
  locationId: '',
  quantity: '',
  reference: '',
  note: '',
};

export const transferFormSchema = z
  .object({
    itemId: pickedId('Pick an item'),
    fromLocationId: pickedId('Pick a bin to move from'),
    toLocationId: pickedId('Pick a bin to move to'),
    quantity: quantityField,
    reference: referenceField,
    note: noteField,
  })
  // Mirrors the server's refusal, so somebody finds out before the round trip
  // rather than from a rejection.
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: 'Pick two different bins',
    path: ['toLocationId'],
  });
export type TransferFormValues = z.infer<typeof transferFormSchema>;

export const emptyTransferForm: TransferFormValues = {
  itemId: '',
  fromLocationId: '',
  toLocationId: '',
  quantity: '',
  reference: '',
  note: '',
};

/**
 * Adjustments are entered as a direction and a positive number.
 *
 * The wire format is signed, but "-3" is a thing people mistype as "3" and then
 * wonder why stock went up. A dropdown that says "write off" cannot be mistyped.
 */
export const ADJUST_DIRECTIONS: readonly AdjustDirection[] = ['decrease', 'increase'];

export const ADJUST_DIRECTION_LABEL: Record<AdjustDirection, string> = {
  decrease: 'Write stock off',
  increase: 'Write stock on',
};

export const adjustFormSchema = z.object({
  itemId: pickedId('Pick an item'),
  locationId: pickedId('Pick a bin'),
  direction: z.enum(['increase', 'decrease']),
  quantity: quantityField,
  reason: adjustmentReasonSchema,
  note: noteField,
});
export type AdjustFormValues = z.infer<typeof adjustFormSchema>;

export const emptyAdjustForm: AdjustFormValues = {
  itemId: '',
  locationId: '',
  direction: 'decrease',
  quantity: '',
  reason: 'miscount',
  note: '',
};

/** The note a reversal carries. Optional, but usually the whole explanation. */
export const reverseFormSchema = z.object({
  note: noteField,
});
export type ReverseFormValues = z.infer<typeof reverseFormSchema>;
