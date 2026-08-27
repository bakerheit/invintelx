import { Router } from 'express';
import { ObjectId } from 'mongodb';
import {
  demoDataResultSchema,
  onboardingStateSchema,
  ROLE_RANK,
} from '@invintelx/shared';
import { ConflictError, NotFoundError } from '../errors.js';
import { asyncHandler } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import {
  isDemoLoaded,
  loadDemoData,
  readOnboardingState,
  removeDemoData,
  whyDemoCannotLoad,
} from '../services/onboarding.js';

/**
 * The first five minutes.
 *
 * Mounted behind `requireAuth`: this says how much data an instance holds,
 * which is nobody's business until they have an account on it. Writing the demo
 * dataset — or taking it away — is admin only, because it is the whole
 * catalogue either way.
 */
export const onboardingRouter: Router = Router();

const REFUSAL_MESSAGE = {
  already_loaded:
    'The demo dataset is already loaded. Remove it first if you want a fresh copy.',
  instance_not_empty:
    'This instance already has items of its own. The demo dataset is only offered to an empty instance, so it cannot be mixed into real data.',
} as const;

onboardingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const canManageDemo = ROLE_RANK[req.user?.role ?? 'viewer'] >= ROLE_RANK.admin;
    res.json(onboardingStateSchema.parse(await readOnboardingState(canManageDemo)));
  }),
);

onboardingRouter.post(
  '/demo',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const refusal = await whyDemoCannotLoad();
    if (refusal) throw new ConflictError(REFUSAL_MESSAGE[refusal]);

    // `requireAuth` ran above, so there is a user; the id is a hex string on
    // the public shape and an ObjectId in the ledger.
    const user = req.user;
    if (!user) throw new NotFoundError('No signed-in user');

    const counts = await loadDemoData({ id: new ObjectId(user.id), name: user.name });
    res.status(201).json(demoDataResultSchema.parse(counts));
  }),
);

onboardingRouter.delete(
  '/demo',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    if (!(await isDemoLoaded())) {
      throw new NotFoundError('There is no demo dataset loaded on this instance');
    }
    res.json(demoDataResultSchema.parse(await removeDemoData()));
  }),
);
