import "server-only";

import {
  type S3Client,
  ListObjectsV2Command,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";

/**
 * Picking the objects that describe what a VST bucket is doing right now.
 *
 * Lives here rather than in the route because it is pure S3 traversal with no
 * request context, and because the route cannot be imported by a unit test (it pulls
 * in next-auth, which pulls in next/server). It is also the seam another caller
 * needs: `src/lib/pipeline/aggregator.ts` reads one unpaginated 1000-key page for
 * the same purpose and has the same blind spot.
 */

/**
 * The newest immediate child "directory" under `prefix`, or null when there is none.
 *
 * ⚠ Ordered NUMERICALLY where the segment is numeric, not lexicographically. VST
 * writes hour directories UNPADDED — `.../2026/08/14/9/` — so a lexicographic max
 * picks "9" over "10" and would report the 9am recordings as the newest of a day
 * that ran until 10am. Month and day are zero-padded, so only the hour level is
 * actually affected today; comparing numerically costs nothing and does not depend
 * on that staying true.
 */
export async function newestChildPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<string | null> {
  const resp = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/" }),
  );
  const children = (resp.CommonPrefixes ?? [])
    .map((p) => p.Prefix)
    .filter((p): p is string => typeof p === "string");
  if (children.length === 0) return null;
  const segment = (p: string) => p.slice(prefix.length).replace(/\/$/, "");
  const allNumeric = children.every((p) => /^\d+$/.test(segment(p)));
  const sorted = [...children].sort((a, b) =>
    allNumeric
      ? Number(segment(a)) - Number(segment(b))
      : segment(a).localeCompare(segment(b)),
  );
  return sorted[sorted.length - 1];
}

/**
 * Objects from the newest recorded hours of the given sensors.
 *
 * Replaces a single unpaginated `ListObjectsV2({MaxKeys: 500})` over the whole
 * bucket. That call returns the LEXICOGRAPHICALLY first 500 keys, and keys are
 * `<sensor-uuid>/YYYY/MM/DD/HH/<epoch>.mkv` — so it only ever saw the sensors whose
 * UUID sorts earliest, then sorted those by LastModified and called them recent.
 *
 * Measured on pyramid-showroom 2026-08-14: 74 sensor prefixes, ≥300k objects. The
 * 500-key window fell entirely inside `01a8a42c-…`, a sensor deleted on Aug 6, so
 * "Recent objects" showed 190-hour-old segments from a camera that no longer exists
 * while all five live cameras were writing 36 MB segments every minute. Every metric
 * derived from that window — the size histogram, segment-duration percentiles — was
 * describing a dead sensor.
 *
 * Walks the date path per sensor instead (year → month → day → hour, newest at each
 * level), which is ~4 small requests per sensor: measured 28ms for a day listing and
 * 20ms for an hour's objects, against 1.4s for one bucket-wide delimiter list.
 */
export async function sampleNewestBySensor(
  s3: S3Client,
  bucket: string,
  sensorIds: string[],
  hoursPerSensor = 2,
): Promise<S3Object[]> {
  const perSensor = await Promise.all(
    sensorIds.map(async (id) => {
      try {
        // Descend to the newest day: <id>/ → year → month → day.
        let dayPrefix: string | null = `${id}/`;
        for (let level = 0; level < 3 && dayPrefix; level++) {
          dayPrefix = await newestChildPrefix(s3, bucket, dayPrefix);
        }
        if (!dayPrefix) return [];
        // Then the newest `hoursPerSensor` hour directories under that day, so the
        // percentiles have more than one segment to difference.
        const hoursResp = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: dayPrefix, Delimiter: "/" }),
        );
        const hours = (hoursResp.CommonPrefixes ?? [])
          .map((p) => p.Prefix)
          .filter((p): p is string => typeof p === "string")
          .sort((a, b) => Number(a.slice(dayPrefix!.length).replace(/\/$/, "")) -
            Number(b.slice(dayPrefix!.length).replace(/\/$/, "")))
          .slice(-hoursPerSensor);
        const pages = await Promise.all(
          hours.map((h) =>
            s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: h })),
          ),
        );
        return pages.flatMap((p) => p.Contents ?? []);
      } catch {
        // One unreadable sensor must not empty the whole sample.
        return [];
      }
    }),
  );
  return perSensor.flat();
}
