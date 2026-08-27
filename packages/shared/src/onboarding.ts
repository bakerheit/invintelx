import { z } from 'zod';
import { isoDateSchema } from './common.js';

/**
 * What a brand new instance has to answer before it can show anything useful:
 * is there anything in here, and is any of it the demo dataset?
 *
 * Both questions are asked of the database rather than remembered in the
 * browser, because "have I been through onboarding" is a property of the
 * instance and not of the laptop looking at it. A second admin signing in from
 * somewhere else must not be walked through a first run that already happened.
 */

/** How much of the demo dataset is still in the database, counted live. */
export const demoDataCountsSchema = z.object({
  items: z.number().int(),
  locations: z.number().int(),
  suppliers: z.number().int(),
  supplierItems: z.number().int(),
  movements: z.number().int(),
});
export type DemoDataCounts = z.infer<typeof demoDataCountsSchema>;

export const demoDataStateSchema = demoDataCountsSchema.extend({
  loadedAt: isoDateSchema,
  /** Name of whoever pressed the button, so the banner can say who to ask. */
  loadedBy: z.string(),
});
export type DemoDataState = z.infer<typeof demoDataStateSchema>;

export const onboardingStateSchema = z.object({
  /** Every item, archived ones included: an archived SKU is still somebody's data. */
  items: z.number().int(),
  locations: z.number().int(),
  movements: z.number().int(),
  /**
   * Nothing at all in the database. This is the one state where the product
   * has nothing to show and every screen would otherwise apologise separately.
   */
  empty: z.boolean(),
  /** Null unless the demo dataset is loaded right now. */
  demo: demoDataStateSchema.nullable(),
  /**
   * Whether loading the demo dataset would be accepted.
   *
   * Not the same question as `empty`, and the client must not guess it from
   * that: an instance holding only the wreckage of a load that died half way
   * through is not empty, and loading the demo is exactly what it needs.
   */
  canLoadDemo: z.boolean(),
  /** Whether the signed-in account may load or remove it. Admin only. */
  canManageDemo: z.boolean(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** What a load or a wipe actually did, so the toast can be specific. */
export const demoDataResultSchema = demoDataCountsSchema;
export type DemoDataResult = z.infer<typeof demoDataResultSchema>;

/**
 * A wipe, which is not quite the mirror image of a load.
 *
 * Somebody looking around the demo has only demo locations to receive their own
 * first SKU into, and only demo suppliers to buy it from. Deleting those would
 * leave their stock sitting at a warehouse that no longer exists — so a demo
 * location or supplier that real data has come to depend on is kept and stops
 * being demo, rather than being removed. These count how often that happened,
 * so the result can say so instead of quietly under-deleting.
 */
export const demoRemovalResultSchema = demoDataResultSchema.extend({
  retainedLocations: z.number().int(),
  retainedSuppliers: z.number().int(),
});
export type DemoRemovalResult = z.infer<typeof demoRemovalResultSchema>;
