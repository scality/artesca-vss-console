// tests/unit/diagram-model.test.ts
//
// ISV-ARCH-05 and ISV-ARCH-06 are served from the ISV portal and badged as
// reading their content from this repository's source. Nothing made that true:
// re-rendering is a manual step in a third repo, so a route added here left the
// sheet describing the previous console, indefinitely and silently. A sheet
// read as current is worse than an absent one.
//
// The check has to live here, because this is the only repository that has the
// source. It cannot see the rendered sheet — that is committed in isv-portal,
// and the scene in isv-presentations — so it does the next best thing and pins
// the *facts the generators extract*. When one moves, the sheet is out of date,
// and the failure says so.
//
// Failing this test is not a bug: it means the console changed. Re-render and
// re-pin —
//
//   npm run diagrams:pin        # rewrite the fixture from the current source
//   # then, in isv-presentations: node diagrams/render-all.mjs
//   # then, in isv-portal:        npm run sync-diagrams
//
// Deliberately a summary, not the whole model. Pinning every route path would
// redden on a rename that changes nothing the sheet draws, and a test that
// cries wolf gets deleted — which would leave the sheets unguarded again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// One definition of "what the sheets print", shared with the re-pin script.
import { liveSummary } from '../../scripts/diagrams/summarise.mjs';

const FIXTURE = join(process.cwd(), 'tests/fixtures/diagram-model.json');

describe('the sheets generated from this repository are still accurate', () => {
  const live = liveSummary();
  const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('ISV-ARCH-05 — the console model has not moved', () => {
    expect(live.console, 're-render ISV-ARCH-05: npm run diagrams:pin, then re-render and sync')
      .toEqual(pinned.console);
  });

  it('ISV-ARCH-06 — the video path has not moved', () => {
    expect(live.flow, 're-render ISV-ARCH-06: npm run diagrams:pin, then re-render and sync')
      .toEqual(pinned.flow);
  });

  it('the fixture covers every field the summary produces', () => {
    // A field added to summarise() but missing from the fixture would compare
    // undefined against undefined and pass — the shape of a parity test that is
    // green because neither side implements the thing.
    expect(Object.keys(pinned).sort()).toEqual(['console', 'flow']);
    expect(Object.keys(pinned.console).sort()).toEqual(Object.keys(live.console).sort());
    expect(Object.keys(pinned.flow).sort()).toEqual(Object.keys(live.flow).sort());
  });
});
