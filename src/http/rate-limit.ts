type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let sweepAt = Date.now() + 60000;

export function allow(scope: string, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (now >= sweepAt) {
    sweepAt = now + 60000;
    for (const [id, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(id);
    }
  }
  const id = `${scope}:${key}`;
  const bucket = buckets.get(id);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}
