import { z } from 'zod';
import {
  decimalToCents,
  centsToDecimal,
  skuSchema,
  unitOfMeasureSchema,
  type CreateItemInput,
  type Item,
} from '@invintelx/shared';

/**
 * The form's shape genuinely differs from the API's: a person types "12.50",
 * the wire format is 1250 cents. Rather than pretend one schema serves both,
 * this is the form contract and the mappers below are the boundary.
 */
export const itemFormSchema = z.object({
  sku: skuSchema,
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000),
  category: z.string().max(100),
  unitOfMeasure: unitOfMeasureSchema,
  barcode: z.string().max(64),
  unitCost: z.coerce.number().min(0, 'Cannot be negative'),
  unitPrice: z.coerce.number().min(0, 'Cannot be negative'),
  reorderPoint: z.coerce.number().int('Whole units only').min(0, 'Cannot be negative'),
  reorderQuantity: z.coerce.number().int('Whole units only').min(0, 'Cannot be negative'),
});

export type ItemFormValues = z.infer<typeof itemFormSchema>;

export const emptyItemForm: ItemFormValues = {
  sku: '',
  name: '',
  description: '',
  category: '',
  unitOfMeasure: 'each',
  barcode: '',
  unitCost: 0,
  unitPrice: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

export function itemToForm(item: Item): ItemFormValues {
  return {
    sku: item.sku,
    name: item.name,
    description: item.description,
    category: item.category,
    unitOfMeasure: item.unitOfMeasure,
    barcode: item.barcode,
    unitCost: centsToDecimal(item.unitCostCents),
    unitPrice: centsToDecimal(item.unitPriceCents),
    reorderPoint: item.reorderPoint,
    reorderQuantity: item.reorderQuantity,
  };
}

export function formToInput(values: ItemFormValues): CreateItemInput {
  return {
    sku: values.sku,
    name: values.name,
    description: values.description,
    category: values.category,
    unitOfMeasure: values.unitOfMeasure,
    barcode: values.barcode,
    unitCostCents: decimalToCents(values.unitCost),
    unitPriceCents: decimalToCents(values.unitPrice),
    reorderPoint: values.reorderPoint,
    reorderQuantity: values.reorderQuantity,
    attributes: {},
  };
}
