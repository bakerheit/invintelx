import { ObjectId } from 'mongodb';
import {
  COUNT_ADJUSTMENT_REASON,
  MAX_COUNT_SHEET_LINES,
  lineVariance,
  type CountSheetScope,
} from '@invintelx/shared';
import {
  countSheets,
  getClient,
  items,
  locations,
  stockLevels,
  type CountSheetDoc,
  type CountSheetLineDoc,
  type ItemDoc,
  type LocationDoc,
  type MovementDoc,
} from '../db.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import {
  assertStockLocation,
  prepareMovements,
  writeMovements,
  type Actor,
  type PostMovementInput,
} from './ledger.js';

/**
 * Cycle counts.
 *
 * The one rule the rest of this file exists to protect: **a count posts its
 * variance, never its count.** Setting on-hand to whatever the counter wrote
 * would silently erase every movement that landed between cutting the sheet and
 * accepting it — a receipt of five booked an hour after the count would vanish,
 * and the ledger would look tidy while being wrong. Writing the difference
 * leaves that receipt standing and still corrects what the count found.
 */

/**
 * Short enough to say over a radio, long enough not to collide.
 *
 * Taken from the sheet's own id rather than a counter document, so opening a
 * sheet stays a single insert. The unique index is what makes it true rather
 * than merely likely — see the retry in `openCountSheet`.
 */
function referenceFor(id: ObjectId): string {
  return `CC-${id.toHexString().slice(-8).toUpperCase()}`;
}

/**
 * Which unique index a write collided with, or null if it did not collide.
 *
 * Two of them can fire on the same insert and they mean opposite things: a
 * reference collision is bad luck and is retried, an overlap collision is the
 * refusal below and must never be retried into success. Reading the key pattern
 * is how they are told apart — matching on the code alone would turn a refusal
 * into five silent retries and then a message about references.
 */
function duplicateKeyOn(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const detail = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (detail.code !== 11000) return null;
  return Object.keys(detail.keyPattern ?? {}).join(',');
}

function isDuplicateReference(error: unknown): boolean {
  return duplicateKeyOn(error) === 'reference';
}

function isDuplicateOpenLine(error: unknown): boolean {
  return duplicateKeyOn(error) === 'locationId,lines.itemId';
}

/** Sorted by SKU, because that is the order somebody walks a shelf reading labels. */
function buildLines(
  itemDocs: ItemDoc[],
  expectedByItem: Map<string, number>,
): CountSheetLineDoc[] {
  return itemDocs
    .map((item) => ({
      _id: new ObjectId(),
      itemId: item._id,
      itemSku: item.sku,
      itemName: item.name,
      expectedQuantity: expectedByItem.get(item._id.toHexString()) ?? 0,
      countedQuantity: null,
      countedAt: null,
      countedById: null,
      countedByName: '',
      postedMovementId: null,
      postedQuantity: null,
    }))
    .sort((a, b) => a.itemSku.localeCompare(b.itemSku));
}

/**
 * The refusal that stops one variance being applied twice, or null if these
 * items are nobody else's count right now.
 *
 * Two open sheets on one bin are two frozen copies of the same expected figure.
 * Books say 10, both count 8, accept the first: on-hand is 8 and correct.
 * Accept the second and it posts its own -2 against the 10 it froze, so the bin
 * lands at 6 for stock nobody recounted. `postCountSheet` cannot see this — its
 * claim is on one document — so the only place to refuse is before the second
 * sheet exists.
 *
 * Overlap is per item rather than per bin. Counting BOLT-1 in A-01 is no reason
 * to refuse a sheet for NUT-1 in A-01, and a bin big enough to need counting in
 * parts is the case this feature has a line ceiling for.
 */
async function openOverlapConflict(
  location: LocationDoc,
  itemDocs: ItemDoc[],
): Promise<ConflictError | null> {
  const wanted = new Set(itemDocs.map((item) => item._id.toHexString()));
  const openHere = await countSheets()
    .find({
      locationId: location._id,
      status: 'open',
      'lines.itemId': { $in: itemDocs.map((item) => item._id) },
    })
    .toArray();

  const clashes = openHere.flatMap((sheet) =>
    sheet.lines
      .filter((line) => wanted.has(line.itemId.toHexString()))
      .map((line) => ({ reference: sheet.reference, sku: line.itemSku })),
  );
  if (clashes.length === 0) return null;

  const references = [...new Set(clashes.map((clash) => clash.reference))].sort();
  const skus = [...new Set(clashes.map((clash) => clash.sku))].sort();
  // Named rather than counted, because the answer is to go and find that sheet.
  const shown = skus.slice(0, 5);
  const listed =
    skus.length > shown.length
      ? `${shown.join(', ')} and ${skus.length - shown.length} more`
      : shown.join(', ');

  return new ConflictError(
    `Already being counted at ${location.code}: ${listed} (on ${references.join(', ')}). Finish or cancel that sheet, or name only the items it does not cover.`,
    { locationId: 'Another open sheet covers these items' },
  );
}

/**
 * Cut a sheet for a bin, freezing what the books currently say.
 *
 * The expected figure is captured now and never re-read. That is the whole
 * point of a variance: it is a claim about a moment, and a sheet that quietly
 * updated its expected column as stock moved would report zero variance for a
 * count that was wrong when it was taken.
 */
export async function openCountSheet(input: {
  locationId: ObjectId;
  itemIds: ObjectId[];
  note: string;
  actor: Actor;
}): Promise<CountSheetDoc> {
  const location = await locations().findOne({ _id: input.locationId });
  if (!location) throw new NotFoundError('No location with that id');
  assertStockLocation(location);

  const requested = [...new Map(input.itemIds.map((id) => [id.toHexString(), id])).values()];
  const scope: CountSheetScope = requested.length > 0 ? 'items' : 'location';

  const levels = await stockLevels().find({ locationId: location._id }).toArray();
  const expectedByItem = new Map(
    levels.map((level) => [level.itemId.toHexString(), level.onHand]),
  );

  let itemDocs: ItemDoc[];
  if (scope === 'items') {
    itemDocs = await items()
      .find({ _id: { $in: requested } })
      .toArray();

    if (itemDocs.length !== requested.length) {
      throw new BadRequestError('Some of those items do not exist', {
        itemIds: 'One or more items could not be found',
      });
    }
    // An archived item cannot take a movement, so a line for one is a line whose
    // variance could never be accepted. Refusing here beats refusing at the end
    // of a count somebody has already walked.
    const archived = itemDocs.filter((item) => item.status !== 'active');
    if (archived.length > 0) {
      throw new BadRequestError(
        `Archived items cannot be counted: ${archived.map((item) => item.sku).join(', ')}`,
        { itemIds: 'Remove the archived items' },
      );
    }
  } else {
    /*
     * Everything the books place in this bin. Archived items are dropped rather
     * than listed: stock can outlive an item's archival, but no adjustment may
     * be written against one, so offering the line would only be a way to reach
     * a refusal. Naming those items explicitly is still refused above, which is
     * the honest signal that they exist.
     */
    itemDocs = await items()
      .find({ _id: { $in: levels.map((level) => level.itemId) }, status: 'active' })
      .toArray();
  }

  if (itemDocs.length === 0) {
    throw new BadRequestError(
      scope === 'items'
        ? 'Nothing to count: none of those items can be counted here'
        : `The books place nothing in ${location.code}. Name the items to count instead.`,
      { locationId: 'Nothing to count at this bin' },
    );
  }
  if (itemDocs.length > MAX_COUNT_SHEET_LINES) {
    throw new BadRequestError(
      `That bin holds ${itemDocs.length} items, and a sheet takes at most ${MAX_COUNT_SHEET_LINES}. Count it in parts.`,
      { locationId: 'Too many lines for one sheet' },
    );
  }

  const overlap = await openOverlapConflict(location, itemDocs);
  if (overlap) throw overlap;

  const now = new Date();
  const base = {
    locationId: location._id,
    locationCode: location.code,
    locationPathLabel: location.pathLabel,
    scope,
    status: 'open' as const,
    note: input.note,
    lines: buildLines(itemDocs, expectedByItem),
    createdAt: now,
    updatedAt: now,
    createdById: input.actor.actorId,
    createdByName: input.actor.actorName,
    postedAt: null,
    postedById: null,
    postedByName: '',
    cancelledAt: null,
  };

  // The reference is derived from the id, so a collision is answered by taking a
  // different id rather than by giving up. Bounded, because a loop that cannot
  // fail is a loop that hangs when the index is missing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const _id = new ObjectId();
    const doc: CountSheetDoc = { _id, reference: referenceFor(_id), ...base };
    try {
      await countSheets().insertOne(doc);
      return doc;
    } catch (error) {
      /*
       * The check above lost a race: two requests both read no open sheet and
       * both went on to insert. `uniq_open_line` is what makes the refusal true
       * rather than likely — the same reason the reference has an index instead
       * of a hope. Re-ask for the message so the loser is told which sheet won,
       * and fall back only if that sheet has closed in the meantime.
       */
      if (isDuplicateOpenLine(error)) {
        throw (
          (await openOverlapConflict(location, itemDocs)) ??
          new ConflictError('Another sheet claimed these items first. Reload and try again.')
        );
      }
      if (!isDuplicateReference(error)) throw error;
    }
  }
  throw new ConflictError('Could not allocate a count sheet reference. Try again.');
}

export async function getCountSheet(id: ObjectId): Promise<CountSheetDoc> {
  const doc = await countSheets().findOne({ _id: id });
  if (!doc) throw new NotFoundError('No count sheet with that id');
  return doc;
}

/**
 * Record what somebody found, or clear it back to uncounted.
 *
 * Null is not zero. "I counted this bin and it was empty" and "nobody has been
 * to this bin" are different facts, and a variance report that confused them
 * would invent a shortage out of an unfinished sheet.
 */
export async function recordCount(input: {
  sheetId: ObjectId;
  lineId: ObjectId;
  countedQuantity: number | null;
  actor: Actor;
}): Promise<CountSheetDoc> {
  const now = new Date();
  const counted = input.countedQuantity !== null;

  const updated = await countSheets().findOneAndUpdate(
    { _id: input.sheetId, status: 'open', 'lines._id': input.lineId },
    {
      $set: {
        'lines.$.countedQuantity': input.countedQuantity,
        'lines.$.countedAt': counted ? now : null,
        'lines.$.countedById': counted ? input.actor.actorId : null,
        'lines.$.countedByName': counted ? input.actor.actorName : '',
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (updated) return updated;

  // Nothing matched, so say which of the three reasons it was rather than a
  // blanket 404 that sends somebody looking for a sheet that is right there.
  const sheet = await getCountSheet(input.sheetId);
  if (sheet.status !== 'open') {
    throw new ConflictError(`This sheet is ${sheet.status}, so its counts are fixed`);
  }
  throw new NotFoundError('No line with that id on this sheet');
}

export interface PostedCountSheet {
  sheet: CountSheetDoc;
  movements: MovementDoc[];
  balances: number[];
}

/**
 * Accept the named variances and close the sheet.
 *
 * Every adjustment and the sheet's own closure go in one transaction, and the
 * claim that opens it is guarded on the sheet's `updatedAt` as well as its
 * status. Two things follow, both of which matter more than they look:
 *
 * - a sheet cannot post twice, so a retried request cannot double-count stock;
 * - a sheet whose counts changed while somebody was reviewing the variances is
 *   refused rather than posted against figures they never saw.
 */
export async function postCountSheet(input: {
  sheetId: ObjectId;
  lineIds: ObjectId[];
  note: string;
  actor: Actor;
}): Promise<PostedCountSheet> {
  const sheet = await getCountSheet(input.sheetId);
  if (sheet.status !== 'open') {
    throw new ConflictError(`This sheet is already ${sheet.status}`);
  }

  const approved = new Set(input.lineIds.map((id) => id.toHexString()));
  const byId = new Map(sheet.lines.map((line) => [line._id.toHexString(), line]));

  const unknown = [...approved].filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new BadRequestError('Some of those lines are not on this sheet', {
      lineIds: 'One or more lines could not be found',
    });
  }

  const approvedLines = sheet.lines.filter((line) => approved.has(line._id.toHexString()));
  const uncounted = approvedLines.filter((line) => line.countedQuantity === null);
  if (uncounted.length > 0) {
    throw new BadRequestError(
      `Nothing was counted for ${uncounted.map((line) => line.itemSku).join(', ')}, so there is no variance to accept`,
      { lineIds: 'Count every line you accept' },
    );
  }

  const now = new Date();
  const toPost = approvedLines
    .map((line) => ({ line, variance: lineVariance(line) ?? 0 }))
    .filter((entry) => entry.variance !== 0);

  const movementInputs: PostMovementInput[] = toPost.map(({ line, variance }) => ({
    itemId: line.itemId,
    locationId: sheet.locationId,
    // The difference, not the count. See the note at the top of this file.
    quantity: variance,
    type: 'adjustment',
    reference: sheet.reference,
    note: input.note,
    reason: COUNT_ADJUSTMENT_REASON,
    occurredAt: now,
    ...input.actor,
  }));

  // Every row built and every target validated before a single write.
  const docs = await prepareMovements(movementInputs, now);

  // `prepareMovements` answers one row per input, in order, so this pairs each
  // accepted line with the adjustment it is about to produce.
  const movementByLine = new Map<string, MovementDoc>();
  toPost.forEach(({ line }, index) => {
    const doc = docs[index];
    if (doc) movementByLine.set(line._id.toHexString(), doc);
  });

  const lines: CountSheetLineDoc[] = sheet.lines.map((line) => {
    const movement = movementByLine.get(line._id.toHexString());
    if (!movement) return line;
    return { ...line, postedMovementId: movement._id, postedQuantity: movement.quantity };
  });

  let posted: CountSheetDoc | null = null;
  let balances: number[] = [];

  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      const claimed = await countSheets().findOneAndUpdate(
        // `updatedAt` is the optimistic-concurrency token: it moves on every
        // count recorded, so matching it proves the lines below are still the
        // ones these variances were computed from.
        { _id: sheet._id, status: 'open', updatedAt: sheet.updatedAt },
        {
          $set: {
            status: 'posted',
            lines,
            postedAt: now,
            postedById: input.actor.actorId,
            postedByName: input.actor.actorName,
            updatedAt: now,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!claimed) {
        throw new ConflictError(
          'This sheet changed while you were reviewing it. Reload the variances and post again.',
        );
      }

      balances = await writeMovements(docs, session, now);
      posted = claimed;
    });
  } finally {
    await session.endSession();
  }

  if (!posted) throw new ConflictError('The count sheet was not posted');
  return { sheet: posted, movements: docs, balances };
}

/**
 * Abandon a sheet without writing anything.
 *
 * The sheet and its counts stay readable. A count that was walked and then
 * thrown away is evidence too, and deleting it would leave the next person
 * wondering why nobody has counted that bin this quarter.
 */
export async function cancelCountSheet(input: {
  sheetId: ObjectId;
  note: string;
  actor: Actor;
}): Promise<CountSheetDoc> {
  const now = new Date();
  const cancelled = await countSheets().findOneAndUpdate(
    { _id: input.sheetId, status: 'open' },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: now,
        updatedAt: now,
        ...(input.note ? { note: input.note } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (cancelled) return cancelled;

  const sheet = await getCountSheet(input.sheetId);
  throw new ConflictError(`This sheet is already ${sheet.status}`);
}
