import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import {
  ALLOWED_PARENT,
  createLocationInputSchema,
  listLocationsQuerySchema,
  locationSchema,
  objectIdSchema,
  paginatedSchema,
  updateLocationInputSchema,
} from '@invintelx/shared';
import { locations, type LocationDoc } from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { toLocation } from '../serializers.js';

export const locationsRouter: Router = Router();

const listResponseSchema = paginatedSchema(locationSchema);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No location with that id');
  return new ObjectId(parsed.data);
}

locationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listLocationsQuerySchema, req.query);

    const filter: Filter<LocationDoc> = {};
    if (!query.includeInactive) filter.isActive = true;
    if (query.type) filter.type = query.type;
    // Membership in `path` matches the whole subtree, including the root itself.
    if (query.under) filter.path = new ObjectId(query.under);
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ code: rx }, { name: rx }, { pathLabel: rx }];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      locations().find(filter).sort({ pathLabel: 1, _id: 1 }).skip(skip).limit(query.pageSize).toArray(),
      locations().countDocuments(filter),
    ]);

    res.json(
      listResponseSchema.parse({
        data: docs.map(toLocation),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

locationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const doc = await locations().findOne({ _id: parseId(req.params.id) });
    if (!doc) throw new NotFoundError('No location with that id');
    res.json(toLocation(doc));
  }),
);

locationsRouter.post(
  '/',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createLocationInputSchema, req.body);
    const expectedParentType = ALLOWED_PARENT[input.type];

    let parent: LocationDoc | null = null;
    if (input.parentId) {
      parent = await locations().findOne({ _id: new ObjectId(input.parentId) });
      if (!parent) throw new NotFoundError('No parent location with that id');
    }

    // The tree has fixed depth, so nesting is a lookup rather than a rule engine.
    if (expectedParentType === null && parent) {
      throw new BadRequestError('A site is top level and cannot have a parent', {
        parentId: 'Sites have no parent',
      });
    }
    if (expectedParentType !== null && !parent) {
      throw new BadRequestError(`A ${input.type} must sit inside a ${expectedParentType}`, {
        parentId: `Pick a ${expectedParentType}`,
      });
    }
    if (parent && expectedParentType !== null && parent.type !== expectedParentType) {
      throw new BadRequestError(
        `A ${input.type} must sit inside a ${expectedParentType}, not a ${parent.type}`,
        { parentId: `Pick a ${expectedParentType}` },
      );
    }

    const now = new Date();
    const id = new ObjectId();
    const doc: LocationDoc = {
      _id: id,
      code: input.code,
      name: input.name,
      type: input.type,
      parentId: parent ? parent._id : null,
      path: parent ? [...parent.path, id] : [id],
      pathLabel: parent ? `${parent.pathLabel} / ${input.code}` : input.code,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    await locations().insertOne(doc);
    res.status(201).json(toLocation(doc));
  }),
);

locationsRouter.patch(
  '/:id',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateLocationInputSchema, req.body);
    const doc = await locations().findOneAndUpdate(
      { _id: parseId(req.params.id) },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No location with that id');
    res.json(toLocation(doc));
  }),
);
