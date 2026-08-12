// Rewrite tests/fixtures/diagram-model.json from the console's current source.
//
// Run this when tests/unit/diagram-model.test.ts fails. That failure means the
// console changed, so ISV-ARCH-05 and ISV-ARCH-06 now describe the previous one.
//
// ⚠ Re-pinning is not the fix. It records the new truth and turns the test
// green while leaving the served sheet exactly as wrong as it was. The sheets
// still have to be re-rendered and synced, which is why that is printed here
// rather than left to memory.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSummary } from './summarise.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'tests/fixtures/diagram-model.json');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(liveSummary(), null, 2) + '\n');
console.log(`pinned ${OUT}`);
console.log('\n⚠ this records the new truth; it does not update the sheets.');
console.log('  next: npm run diagrams in isv-portal-adjacent repos, render in');
console.log('        isv-presentations, then npm run sync-diagrams in isv-portal');
