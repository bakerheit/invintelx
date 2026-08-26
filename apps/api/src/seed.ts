/**
 * Loads a demo dataset into the local database so a fresh clone has something
 * to look at. Development only - it refuses to touch a production database.
 *
 * Run with: pnpm db:seed
 */
import { ObjectId } from 'mongodb';
import type { UnitOfMeasure } from '@invintelx/shared';
import { env } from './env.js';
import { connect, disconnect, ensureIndexes, items, sessions, users, type ItemDoc } from './db.js';
import { hashPassword } from './lib/password.js';

const DEMO_EMAIL = 'demo@invintelx.org';
const DEMO_PASSWORD = 'invintelx-demo-password';

interface SeedItem {
  sku: string;
  name: string;
  category: string;
  unitOfMeasure: UnitOfMeasure;
  costCents: number;
  priceCents: number;
  reorderPoint: number;
  reorderQuantity: number;
}

const CATALOG: SeedItem[] = [
  { sku: 'BOLT-M6-30', name: 'Hex bolt M6 x 30mm', category: 'Fasteners', unitOfMeasure: 'each', costCents: 12, priceCents: 45, reorderPoint: 2000, reorderQuantity: 5000 },
  { sku: 'BOLT-M8-40', name: 'Hex bolt M8 x 40mm', category: 'Fasteners', unitOfMeasure: 'each', costCents: 19, priceCents: 65, reorderPoint: 1500, reorderQuantity: 4000 },
  { sku: 'NUT-M6', name: 'Hex nut M6', category: 'Fasteners', unitOfMeasure: 'each', costCents: 6, priceCents: 22, reorderPoint: 3000, reorderQuantity: 8000 },
  { sku: 'WASH-M6', name: 'Flat washer M6', category: 'Fasteners', unitOfMeasure: 'each', costCents: 3, priceCents: 14, reorderPoint: 4000, reorderQuantity: 10000 },
  { sku: 'SCRW-WD-40', name: 'Wood screw 4 x 40mm', category: 'Fasteners', unitOfMeasure: 'each', costCents: 8, priceCents: 30, reorderPoint: 2500, reorderQuantity: 6000 },
  { sku: 'PVC-P-20', name: 'PVC pipe 20mm x 3m', category: 'Plumbing', unitOfMeasure: 'each', costCents: 340, priceCents: 899, reorderPoint: 120, reorderQuantity: 300 },
  { sku: 'PVC-P-32', name: 'PVC pipe 32mm x 3m', category: 'Plumbing', unitOfMeasure: 'each', costCents: 520, priceCents: 1349, reorderPoint: 90, reorderQuantity: 240 },
  { sku: 'PVC-ELB-20', name: 'PVC elbow 20mm 90deg', category: 'Plumbing', unitOfMeasure: 'each', costCents: 45, priceCents: 149, reorderPoint: 400, reorderQuantity: 1000 },
  { sku: 'PVC-TEE-20', name: 'PVC tee 20mm', category: 'Plumbing', unitOfMeasure: 'each', costCents: 58, priceCents: 189, reorderPoint: 350, reorderQuantity: 800 },
  { sku: 'SEAL-PTFE', name: 'PTFE thread seal tape 12mm', category: 'Plumbing', unitOfMeasure: 'each', costCents: 62, priceCents: 249, reorderPoint: 300, reorderQuantity: 600 },
  { sku: 'CBL-25-TW', name: 'Twin and earth cable 2.5mm', category: 'Electrical', unitOfMeasure: 'm', costCents: 118, priceCents: 349, reorderPoint: 500, reorderQuantity: 1500 },
  { sku: 'CBL-15-TW', name: 'Twin and earth cable 1.5mm', category: 'Electrical', unitOfMeasure: 'm', costCents: 89, priceCents: 269, reorderPoint: 600, reorderQuantity: 1800 },
  { sku: 'SKT-2G-13A', name: 'Double socket 13A white', category: 'Electrical', unitOfMeasure: 'each', costCents: 410, priceCents: 1099, reorderPoint: 150, reorderQuantity: 400 },
  { sku: 'SWCH-1G-10A', name: 'Single light switch 10A', category: 'Electrical', unitOfMeasure: 'each', costCents: 260, priceCents: 749, reorderPoint: 200, reorderQuantity: 500 },
  { sku: 'MCB-B16', name: 'Circuit breaker B16', category: 'Electrical', unitOfMeasure: 'each', costCents: 640, priceCents: 1599, reorderPoint: 80, reorderQuantity: 200 },
  { sku: 'PAINT-WH-5L', name: 'Matt emulsion white 5L', category: 'Paint', unitOfMeasure: 'each', costCents: 1450, priceCents: 3299, reorderPoint: 60, reorderQuantity: 150 },
  { sku: 'PAINT-MG-5L', name: 'Matt emulsion magnolia 5L', category: 'Paint', unitOfMeasure: 'each', costCents: 1450, priceCents: 3299, reorderPoint: 50, reorderQuantity: 120 },
  { sku: 'PAINT-UC-25L', name: 'Undercoat 2.5L', category: 'Paint', unitOfMeasure: 'each', costCents: 1190, priceCents: 2749, reorderPoint: 40, reorderQuantity: 100 },
  { sku: 'BRSH-50', name: 'Paint brush 50mm', category: 'Paint', unitOfMeasure: 'each', costCents: 210, priceCents: 649, reorderPoint: 100, reorderQuantity: 250 },
  { sku: 'ROLL-230', name: 'Paint roller 230mm', category: 'Paint', unitOfMeasure: 'each', costCents: 290, priceCents: 849, reorderPoint: 90, reorderQuantity: 200 },
  { sku: 'TIMB-2X4-24', name: 'Timber 2x4 2.4m treated', category: 'Timber', unitOfMeasure: 'each', costCents: 480, priceCents: 1199, reorderPoint: 200, reorderQuantity: 500 },
  { sku: 'TIMB-2X6-36', name: 'Timber 2x6 3.6m treated', category: 'Timber', unitOfMeasure: 'each', costCents: 1120, priceCents: 2649, reorderPoint: 120, reorderQuantity: 300 },
  { sku: 'PLY-18-8X4', name: 'Plywood 18mm 8x4 sheet', category: 'Timber', unitOfMeasure: 'each', costCents: 3450, priceCents: 7499, reorderPoint: 40, reorderQuantity: 100 },
  { sku: 'MDF-12-8X4', name: 'MDF 12mm 8x4 sheet', category: 'Timber', unitOfMeasure: 'each', costCents: 2180, priceCents: 4899, reorderPoint: 50, reorderQuantity: 120 },
  { sku: 'OSB-11-8X4', name: 'OSB3 11mm 8x4 sheet', category: 'Timber', unitOfMeasure: 'each', costCents: 1890, priceCents: 4299, reorderPoint: 60, reorderQuantity: 150 },
  { sku: 'GLOVE-NIT-L', name: 'Nitrile gloves large box of 100', category: 'Safety', unitOfMeasure: 'case', costCents: 890, priceCents: 1999, reorderPoint: 40, reorderQuantity: 120 },
  { sku: 'GLASS-SAFE', name: 'Safety glasses clear', category: 'Safety', unitOfMeasure: 'each', costCents: 320, priceCents: 899, reorderPoint: 80, reorderQuantity: 200 },
  { sku: 'HELM-WH', name: 'Hard hat white', category: 'Safety', unitOfMeasure: 'each', costCents: 780, priceCents: 1899, reorderPoint: 50, reorderQuantity: 100 },
  { sku: 'BOOT-ST-10', name: 'Steel toe boots size 10', category: 'Safety', unitOfMeasure: 'each', costCents: 3890, priceCents: 7999, reorderPoint: 20, reorderQuantity: 50 },
  { sku: 'VEST-HV-L', name: 'Hi-vis vest large', category: 'Safety', unitOfMeasure: 'each', costCents: 290, priceCents: 799, reorderPoint: 100, reorderQuantity: 250 },
  { sku: 'DRILL-18V', name: 'Cordless drill 18V', category: 'Tools', unitOfMeasure: 'each', costCents: 8900, priceCents: 17999, reorderPoint: 12, reorderQuantity: 30 },
  { sku: 'BIT-HSS-SET', name: 'HSS drill bit set 19 piece', category: 'Tools', unitOfMeasure: 'each', costCents: 1450, priceCents: 3499, reorderPoint: 30, reorderQuantity: 80 },
  { sku: 'HAMR-CLAW', name: 'Claw hammer 16oz', category: 'Tools', unitOfMeasure: 'each', costCents: 980, priceCents: 2299, reorderPoint: 40, reorderQuantity: 100 },
  { sku: 'TAPE-5M', name: 'Tape measure 5m', category: 'Tools', unitOfMeasure: 'each', costCents: 420, priceCents: 1099, reorderPoint: 60, reorderQuantity: 150 },
  { sku: 'LEVEL-600', name: 'Spirit level 600mm', category: 'Tools', unitOfMeasure: 'each', costCents: 1180, priceCents: 2699, reorderPoint: 25, reorderQuantity: 60 },
  { sku: 'CEM-OPC-25', name: 'Portland cement 25kg', category: 'Aggregates', unitOfMeasure: 'each', costCents: 620, priceCents: 1349, reorderPoint: 150, reorderQuantity: 400 },
  { sku: 'SAND-SHRP-25', name: 'Sharp sand 25kg', category: 'Aggregates', unitOfMeasure: 'each', costCents: 280, priceCents: 649, reorderPoint: 200, reorderQuantity: 600 },
  { sku: 'GRVL-20-25', name: 'Gravel 20mm 25kg', category: 'Aggregates', unitOfMeasure: 'each', costCents: 310, priceCents: 699, reorderPoint: 180, reorderQuantity: 500 },
  { sku: 'BLK-CONC-100', name: 'Concrete block 100mm', category: 'Aggregates', unitOfMeasure: 'each', costCents: 145, priceCents: 349, reorderPoint: 500, reorderQuantity: 1200 },
  { sku: 'BRICK-CMN', name: 'Common brick', category: 'Aggregates', unitOfMeasure: 'each', costCents: 58, priceCents: 139, reorderPoint: 2000, reorderQuantity: 5000 },
];

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  await connect();
  await ensureIndexes();

  console.log(`Seeding ${env.MONGODB_DB}...`);

  // Wipe first so the seed is repeatable rather than accumulating duplicates.
  await Promise.all([items().deleteMany({}), users().deleteMany({}), sessions().deleteMany({})]);

  const now = new Date();
  await users().insertOne({
    _id: new ObjectId(),
    email: DEMO_EMAIL,
    name: 'Demo Admin',
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  });

  const docs: ItemDoc[] = CATALOG.map((seed, index) => ({
    _id: new ObjectId(),
    sku: seed.sku,
    name: seed.name,
    description: '',
    category: seed.category,
    unitOfMeasure: seed.unitOfMeasure,
    barcode: `50${String(100000 + index).padStart(8, '0')}`,
    unitCostCents: seed.costCents,
    unitPriceCents: seed.priceCents,
    reorderPoint: seed.reorderPoint,
    reorderQuantity: seed.reorderQuantity,
    status: 'active',
    attributes: {},
    // Spread updatedAt across recent days so the default sort is not arbitrary.
    createdAt: new Date(now.getTime() - (CATALOG.length - index) * 36e5),
    updatedAt: new Date(now.getTime() - (CATALOG.length - index) * 36e5),
  }));
  await items().insertMany(docs);

  console.log(`  ${docs.length} items`);
  console.log(`  1 user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('Done.');

  await disconnect();
}

main().catch((err: unknown) => {
  console.error('Seed failed', err);
  process.exit(1);
});
