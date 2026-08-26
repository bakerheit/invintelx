import { z } from 'zod';
import { isoDateSchema, objectIdSchema, paginationQuerySchema } from './common.js';

/**
 * Locations form a tree: a site contains zones, a zone contains bins.
 *
 * Stock is only ever held at a leaf. That rule is what keeps on-hand from being
 * counted twice — if a zone could hold stock as well as its bins, "how much is
 * in this warehouse" would have two defensible answers.
 */
export const LOCATION_TYPES = ['site', 'zone', 'bin'] as const;
export const locationTypeSchema = z.enum(LOCATION_TYPES);
export type LocationType = z.infer<typeof locationTypeSchema>;

/** Depth is fixed, so what may nest under what is a lookup, not a rule engine. */
export const ALLOWED_PARENT: Record<LocationType, LocationType | null> = {
  site: null,
  zone: 'site',
  bin: 'zone',
};

/** Only a bin holds stock. */
export function holdsStock(type: LocationType): boolean {
  return type === 'bin';
}

export const locationCodeSchema = z
  .string()
  .trim()
  .min(1, 'Code is required')
  .max(64, 'Code must be at most 64 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'Use letters, numbers, dot, dash, slash or underscore')
  .transform((v) => v.toUpperCase());

export const locationSchema = z.object({
  id: objectIdSchema,
  code: z.string(),
  name: z.string(),
  type: locationTypeSchema,
  parentId: objectIdSchema.nullable(),
  /**
   * Materialised ancestry, root first, this location last. "Everything under
   * warehouse A" becomes one indexed prefix query instead of a recursive walk.
   */
  path: z.array(objectIdSchema),
  /** Human-readable ancestry for display, e.g. "MAIN / CHILLED / A-01". */
  pathLabel: z.string(),
  isActive: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Location = z.infer<typeof locationSchema>;

export const createLocationInputSchema = z.object({
  code: locationCodeSchema,
  name: z.string().trim().min(1, 'Name is required').max(200),
  type: locationTypeSchema,
  parentId: objectIdSchema.nullable().default(null),
});
export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;

export const updateLocationInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;

export const listLocationsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  type: locationTypeSchema.optional(),
  /** Restrict to the subtree beneath this location. */
  under: objectIdSchema.optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
