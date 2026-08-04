# Kiosk mode

Source: [`console/CLAUDE.md`](../../../console/CLAUDE.md) §"Page tree", [`console/src/app/`](../../../console/src/app/).

## What it is

Kiosk mode renders the console in a chrome-free full-screen layout designed for an unattended monitor — for example, the showroom display at a Pyramid retail workshop showing a live incident feed.

Activated by the `?mode=kiosk` query parameter on any console URL. Only the **Incidents** page is visible in kiosk mode. Navigation, menus, auth banners, and all other pages are hidden.

## How to launch

```
http://<node-public-ip>:8800/?mode=kiosk
```

Or, when using port-forward:
```
http://localhost:8800/?mode=kiosk
```

For a fixed browser kiosk (no cursor, no address bar, no window decorations) on a dedicated showroom display:

```bash
# Chrome on the display machine
google-chrome --kiosk "http://<console-host>:8800/?mode=kiosk"
```

## What's hidden

All pages except Incidents are hidden in kiosk mode:

- `/` Overview
- `/topology`
- `/cameras`
- `/scenarios`
- `/prompt`
- `/tuning`
- `/demo-data`
- `/profiles`
- `/secrets`
- `/logs`
- `/diagnostics`
- `/settings`

Visibility logic: `console/src/components/AppShell.tsx`.

## Showroom setup checklist (Pyramid)

Before opening the kiosk display at a public-facing demo:

- [ ] Verify host port `:8800` is reachable from the showroom LAN (SG inbound rule open, or set up a port-forward laptop as the display host)
- [ ] Confirm Demo Data mode is **off** (Demo Data page → replicas = 0) — real cameras should be the event source, not the synthetic producer
- [ ] Verify the scenario list matches what's staged for the demo: open `/scenarios` and confirm keyword rules for the three Pyramid scenarios (scan verification, shelf heat-mapping, pallet tracking)
- [ ] Test with a synthetic event to confirm end-to-end pipeline: `scripts/stacks/nvidia-vss/fire-synthetic-event.sh --instance <name>` should produce a visible incident on the Incidents page within ~10s
- [ ] Switch browser to `?mode=kiosk` URL and verify incidents appear with no chrome
- [ ] If screen saver / power-saving is active on the display machine, disable it before the session

Full operator runbook for the Pyramid showroom: [`docs/demo-runbook.md`](../../../docs/demo-runbook.md).

Demo readiness gates (G0–G8f), including on-site dry-run and GDPR network isolation checklist: [`docs/demo-readiness.md`](../../../docs/demo-readiness.md).
