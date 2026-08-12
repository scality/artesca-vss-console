// The facts ISV-ARCH-05 and ISV-ARCH-06 print, extracted from this repository.
//
// One definition, imported by both the test that guards the sheets and the
// script that re-pins them. Two copies of "what the sheets print" would drift,
// and the direction it drifts is a test that passes while the sheet is wrong.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run one of the dump scripts and parse its JSON. */
export function dump(script, reactServer = false) {
  // dump-flow imports cluster-refs through modules guarded by `server-only`,
  // whose default entry throws by design; the react-server condition resolves
  // it to the variant that does not.
  const args = [...(reactServer ? ['--conditions=react-server'] : []), join(HERE, script)];
  return JSON.parse(execFileSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

/**
 * A summary, not the whole model: pinning every route path would redden on a
 * rename that changes nothing either sheet draws, and a test that cries wolf
 * gets deleted — which leaves the sheets unguarded, the state this exists to
 * end.
 */
export function summarise(model, flow) {
  return {
    console: {
      pageCount: model.pageCount,
      navGroups: model.nav.length,
      navEntries: model.nav.reduce((a, g) => a + g.routes.length, 0),
      navLabels: model.nav.map(g => g.label),
      kioskHidden: [...model.kiosk.hidden].sort(),
      kioskAllowed: [...model.kiosk.allowed].sort(),
      apiRoutes: model.api.length,
      mutatingCount: model.mutatingCount,
      guardedCount: model.guardedCount,
      backendCounts: model.backendCounts,
      configStoreKeys: Object.keys(model.configStore).sort(),
      guardExempt: Object.keys(model.guardExempt).sort(),
      orphaned: [...model.orphaned].sort(),
    },
    flow: {
      namespace: flow.namespace,
      stages: flow.stages.length,
      controls: flow.controls.length,
      reads: flow.reads.length,
      restartable: [...flow.restartable].sort(),
      topics: Object.keys(flow.topics).sort(),
      buckets: Object.keys(flow.buckets).sort(),
    },
  };
}

/** The live summary, read from source. */
export const liveSummary = () => summarise(dump('dump-model.mjs'), dump('dump-flow.mjs', true));
