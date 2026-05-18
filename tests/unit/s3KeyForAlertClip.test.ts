// Parity tests for s3KeyForAlertClip — output must be byte-identical to the
// Python implementation in k8s/nvidia-vss/alerts/clip_key.py.
//
// Python uses: math.floor(x/10 + 0.5) * 10  (half-up rounding)
// TypeScript uses: Math.round(epochS / 10) * 10  (also half-up)
//
// Source of truth for test vectors: tests/alerts/test_clip_key_derivation.py

import { describe, it, expect } from "vitest";
import { s3KeyForAlertClip } from "@/lib/s3";

describe("s3KeyForAlertClip", () => {
  it("rounds 27.5s to the 30s boundary (nearest-10s, rounds up)", () => {
    // Python: derive_clip_key("cam-01", "2026-05-15T14:03:27.500Z")
    //         == "cam-01/2026-05-15T14-03-30.mp4"
    expect(s3KeyForAlertClip("cam-01", "2026-05-15T14:03:27.500Z")).toBe(
      "cam-01/2026-05-15T14-03-30.mp4"
    );
  });

  it("rounds 24s down to the 20s boundary (under 5s past boundary)", () => {
    // Python: derive_clip_key("cam-01", "2026-05-15T14:03:24.000Z")
    //         == "cam-01/2026-05-15T14-03-20.mp4"
    expect(s3KeyForAlertClip("cam-01", "2026-05-15T14:03:24.000Z")).toBe(
      "cam-01/2026-05-15T14-03-20.mp4"
    );
  });

  it("rounds 25s (half-up) to the 30s boundary (must match Python half-up behaviour)", () => {
    // Python clip_key.py uses math.floor(x/10 + 0.5)*10 which rounds half UP.
    // Math.round() in JS also rounds half UP. Both give 30s for exactly 25s.
    // Python: derive_clip_key("cam-01", "2026-05-15T14:03:25Z")
    //         == "cam-01/2026-05-15T14-03-30.mp4"
    expect(s3KeyForAlertClip("cam-01", "2026-05-15T14:03:25Z")).toBe(
      "cam-01/2026-05-15T14-03-30.mp4"
    );
  });

  it("converts a non-UTC offset to UTC before rounding", () => {
    // 16:03:27+02:00 == 14:03:27 UTC → rounds to 14:03:30 UTC.
    // Python: derive_clip_key("cam-01", "2026-05-15T16:03:27+02:00")
    //         == "cam-01/2026-05-15T14-03-30.mp4"
    expect(s3KeyForAlertClip("cam-01", "2026-05-15T16:03:27+02:00")).toBe(
      "cam-01/2026-05-15T14-03-30.mp4"
    );
  });
});
