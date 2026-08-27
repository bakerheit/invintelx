import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  abcQuerySchema,
  abcResponseSchema,
  actionListQuerySchema,
  actionListResponseSchema,
  dashboardQuerySchema,
  dashboardResponseSchema,
  deadStockQuerySchema,
  deadStockResponseSchema,
  demandStatsSchema,
  objectIdSchema,
  reorderSuggestionSchema,
} from '@invintelx/shared';
import { items, stockLevels } from '../db.js';
import { NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import {
  buildAbcReport,
  buildActionList,
  buildDashboard,
  buildDeadStockReport,
  demandByItem,
  statsFromSeries,
  suggestReorder,
} from '../services/analytics.js';

export const analyticsRouter: Router = Router();

/**
 * The landing screen: what is out, what is about to be, what has stopped
 * moving, and how much the whole thing is worth.
 *
 * Declared ahead of `/demand/:itemId` for readability only — Express matches
 * literal segments before parameterised ones on distinct paths, and these two
 * do not overlap.
 */
analyticsRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(dashboardQuerySchema, req.query);
    const snapshot = await buildDashboard(query);

    // Validating our own response catches contract drift here rather than as a
    // confusing parse failure in the browser.
    res.json(
      dashboardResponseSchema.parse({ generatedAt: new Date().toISOString(), ...snapshot }),
    );
  }),
);

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

/**
 * The catalogue by annual consumption value, banded A/B/C.
 *
 * Literal segment, declared before `/demand/:itemId` for readability only.
 */
analyticsRouter.get(
  '/abc',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(abcQuerySchema, req.query);
    const snapshot = await buildAbcReport(query);

    // Validating our own response catches contract drift here rather than as a
    // confusing parse failure in the browser.
    res.json(abcResponseSchema.parse({ generatedAt: new Date().toISOString(), ...snapshot }));
  }),
);

/** Stock nobody has issued in the window, and the capital sitting in it. */
analyticsRouter.get(
  '/dead-stock',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(deadStockQuerySchema, req.query);
    const snapshot = await buildDeadStockReport(query);

    res.json(deadStockResponseSchema.parse({ generatedAt: new Date().toISOString(), ...snapshot }));
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
