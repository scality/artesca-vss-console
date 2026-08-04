# Camera operations

VSS ingests via VST (Video Storage Toolkit), which polls a registry of RTSP camera URLs. The console writes camera registrations to two surfaces in parallel: the K8s ConfigMap `cameras` in ns `pyramid-ingress` (drives the in-cluster `register-cameras` Job) and the GCS canonical at `gs://scality-isv-labs-config/cameras/<instance>.json` (schema `isv-labs.cameras.v1` or `v2`, versioned object). Source: [`console/src/app/cameras/`](../../../console/src/app/cameras/), [`scripts/sync-cameras.sh`](../../../scripts/sync-cameras.sh).

## Add a camera (console UI)

1. Open `/cameras` on the console.
2. Click **Add Camera**.
3. Fill in the form: name, RTSP URL, codec hint (H.264 or H.265), optional scenario tags.
4. Click **Save**.

Behind the scenes: `gcsCamerasPut` writes a new versioned object to GCS. The in-cluster `register-cameras` Job reads from GCS and POSTs each camera to VST via `POST /vst/api/v1/sensor/add` on every restart (or manual trigger).

On the **docker path** (`RUNTIME=docker`, Brev), a second API call is required for recording to start — see §Docker-path two-step below.

## Add a camera (CLI fallback)

Use when the console is unreachable or for scripted bulk registration.

```bash
# Pull current list for this instance
scripts/sync-cameras.sh --pull --instance <name>

# Edit scripts/instances/<name>/cameras.json locally, then push
scripts/sync-cameras.sh --push --instance <name> --file scripts/instances/<name>/cameras.json
```

Auto-restore on next cluster restart via `bootstrap-compose-console.sh`. Manual restore:
```bash
scripts/sync-cameras.sh --restore --instance <name> --vst-host <host>
```

## Common camera issues

| Symptom | Fix |
|---|---|
| "RTSP timeout" on camera add | Verify the SG allows inbound TCP from the VST node to the camera source on `:8554` (or the camera's port). Test from inside the cluster: `kubectl -n vst exec deploy/vst -- ffprobe <rtsp-url>` |
| Stream drops every N seconds | Tune the RTSP reconnection env vars in [`k8s/nvidia-vss/rtvi/41-rtvi-embed.yaml`](../../../k8s/nvidia-vss/rtvi/41-rtvi-embed.yaml): `RTVI_RTSP_RECONNECTION_INTERVAL` (default 5s), `RTVI_RTSP_RECONNECTION_MAX_ATTEMPTS` (default 10). |
| Camera registered in UI but not recording to S3 | Docker path only — `sensor/add` does not start the recording pipeline. Run step 2 (`proxy/stream/add`) via the console's camera-restore-watcher or `bootstrap-compose-console.sh`. |
| Camera not picked up after cluster restart | Verify the GCS canonical has the entry: `gcloud storage cat gs://scality-isv-labs-config/cameras/<instance>.json`. If missing, push from console or run `sync-cameras.sh --push`. |

## Docker-path two-step

On the docker path (`RUNTIME=docker`, Brev), registering a camera requires two API calls (source: `scripts/stacks/nvidia-vss/CLAUDE.md`):

**Step 1 — metadata registration** (`sensor/add`):
- `POST http://<host>:30888/vst/api/v1/sensor/add`
- Payload: `{sensorUrl, name, username, description}` — `username` is required (empty string is valid; omitting it returns HTTP 400)
- Effect: writes `sensor_streams.stream_live_url`; does not start recording

**Step 2 — recording pipeline** (`proxy/stream/add`):
- `POST http://127.0.0.1:30001/api/v1/proxy/stream/add` (only reachable from inside the VSS box)
- Payload: `{url, id, name}`
- Effect: populates `sensor_details.url` and starts the recording pipeline into S3
- HTTP 409 = already registered — treat as success

The console's `camera-restore-watcher.ts` calls both steps in sequence when `CONSOLE_RUNTIME=docker`. `scripts/sync-cameras.sh` only performs step 1.

VST Postgres (container `centralizedb-dev`, user `vst`, db `nvcentralizedb`): if `sensor_details.url` is NULL after a restore, backfill with:
```sql
UPDATE sensor_details SET url = ss.stream_live_url
FROM sensor_streams ss
WHERE ss.sensor_id = sensor_details.sensor_id
  AND (sensor_details.url IS NULL OR sensor_details.url = '');
```

## Camera-sim pairing

When a `camera-sim` instance is paired via the solutions role-binding system, the camera-sim EC2 publishes RTSP streams at `<camera-sim-pub-ip>:8554`. The console camera list reads eligible RTSP URLs from the camera-sim's eligibility endpoint (configured in the solution binding).

Launch a camera-sim EC2:
```bash
scripts/launch-camera-sim.sh --instance <name>
```

Source: [`scripts/launch-camera-sim.sh`](../../../scripts/launch-camera-sim.sh). End-to-end setup: [`docs/camera-sim-setup.md`](../../../docs/camera-sim-setup.md). Test-footage codec and bitrate spec: [`docs/test-footage-spec.md`](../../../docs/test-footage-spec.md).

For the Pyramid showroom, real cameras connect directly over the showroom LAN — the camera-sim is only used for lab rehearsals.
