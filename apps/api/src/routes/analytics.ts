import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  actionListQuerySchema,
  actionListResponseSchema,
  demandStatsSchema,
  objectIdSchema,
  reorderSuggestionSchema,
} from '@invintelx/shared';
import { items, stockLevels } from '../db.js';
import { NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { buildActionList, demandByItem, statsFromSeries, suggestReorder } from '../services/analytics.js';

export const analyticsRouter: Router = Router();

/** The dashboard's only card: what to reorder today, worst first. */
analyticsRouter.get(
  '/action-list',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(actionListQuerySchema, req.query);
    const { suggestions, itemsConsidered } = await buildActionList(query);

    res.json(
      actionListResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        windowDays: query.windowDays,
        leadTimeDays: query.leadTimeDays,
        serviceLevel: query.serviceLevel,
        itemsConsidered,
        items: suggestions,
      }),
    );
  }),
);

const demandQuerySchema = actionListQuerySchema.pick({
  windowDays: true,
  leadTimeDays: true,
  serviceLevel: true,
});

/** One item's demand series and the suggestion derived from it, working shown. */
analyticsRouter.get(
  '/demand/:itemId',
  asyncHandler(async (req, res) => {
    const parsed = objectIdSchema.safeParse(req.params.itemId);
    if (!parsed.success) throw new NotFoundError('No item with that id');
    const itemId = new ObjectId(parsed.data);
    const query = parseOrThrow(demandQuerySchema, req.query);

    const item = await items().findOne({ _id: itemId });
    if (!item) throw new NotFoundError('No item with that id');

    const [demand, levels] = await Promise.all([
      demandByItem([itemId], query.windowDays),
      stockLevels().find({ itemId }).toArray(),
    ]);

    const key = itemId.toHexString();
    const stats = statsFromSeries(key, demand.get(key) ?? [], query.windowDays);
    const onHand = levels.reduce((sum, level) => sum + level.onHand, 0);

    // Validating our own response catches contract drift here rather than as a
    // confusing parse failure in the browser.
    const responseSchema = z.object({
      stats: demandStatsSchema,
      suggestion: reorderSuggestionSchema,
    });

    res.json(
      responseSchema.parse({
        stats,
        suggestion: suggestReorder(item, stats, onHand, query.leadTimeDays, query.serviceLevel),
      }),
    );
  }),
);
