// Phase 3 / design-doc decision E: preview NIM call.
// All tests here are fixme — out-of-reach without a live cluster running NVILA-Lite-2B.
import { test } from "@playwright/test";

test.describe("preview NIM — requires live cluster", () => {
  test.fixme(
    "prompt preview sends request to NVILA-Lite-2B preview NIM and renders response",
    async () => {
      // Phase 3 exit criterion (live part): clicking "Preview" on the prompt page must
      // POST to /api/prompt/preview, which forwards to the NVILA-Lite-2B instance
      // sharing GPU 0 alongside the primary Cosmos 2 8B NIM (design-doc decision E & J).
      // Requires:
      //   - A live g6e.12xlarge (4× L40S 48 GB) instance running ARTESCA.
      //   - nvila-lite-2b deployed with -shared-gpu profile on GPU 0.
      //   - The console pod deployed in-cluster with K8s ServiceAccount access.
      // Cannot be tested in a stub-only environment.
    }
  );

  test.fixme(
    "NIM warmup state shown on prompt page (preview NIM not ready during warmup)",
    async () => {
      // When NVILA-Lite-2B is warming up (~60 s per design-doc decision J), the preview
      // button tooltip should indicate "Preview NIM warming up" and remain disabled.
      // Verification requires observing the real NIM /health endpoint during warmup.
      // Cannot be tested without a live cluster.
    }
  );

  test.fixme(
    "model swap: Cosmos 2 8B ↔ Cosmos 1 7B changes NIM ConfigMap + rollout-restart",
    async () => {
      // Design-doc decision D: model swap on the /prompt page calls PATCH /api/prompt
      // with a model field, which rewrites the rtvi-vlm + NIM ConfigMaps and rollout-
      // restarts both Deployments. Verification requires kubectl get configmap + rollout
      // status. Cannot be tested without a live cluster.
    }
  );
});
