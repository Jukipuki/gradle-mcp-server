const SEARCH_URL = "https://search.maven.org/solrsearch/select";
const FETCH_TIMEOUT_MS = 10_000;

const latestCache = new Map<string, { value: string | null; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

const PRERELEASE_REGEX = /(SNAPSHOT|alpha|beta|rc|preview|cr|m\d+|ea|dev)/i;

export function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[.\-_+]/);
  const partsB = b.split(/[.\-_+]/);
  const max = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < max; i++) {
    const pa = partsA[i] ?? "0";
    const pb = partsB[i] ?? "0";
    const na = /^\d+$/.test(pa) ? parseInt(pa, 10) : NaN;
    const nb = /^\d+$/.test(pb) ? parseInt(pb, 10) : NaN;
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return PRERELEASE_REGEX.test(version);
}

async function fetchLatest(group: string, artifact: string): Promise<string | null> {
  const key = `${group}:${artifact}`;
  const cached = latestCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  const q = `g:"${group}" AND a:"${artifact}"`;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&rows=1&wt=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      latestCache.set(key, { value: null, ts: Date.now() });
      return null;
    }
    const json = (await res.json()) as {
      response?: { docs?: Array<{ latestVersion?: string; v?: string }> };
    };
    const doc = json.response?.docs?.[0];
    const value = doc?.latestVersion ?? doc?.v ?? null;
    latestCache.set(key, { value, ts: Date.now() });
    return value;
  } catch {
    latestCache.set(key, { value: null, ts: Date.now() });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface OutdatedInput {
  group: string;
  artifact: string;
  version: string;
}

export interface OutdatedResult {
  group: string;
  artifact: string;
  current: string;
  latest: string;
  outdated: boolean;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function checkOutdated(deps: OutdatedInput[]): Promise<OutdatedResult[]> {
  const results = await mapWithConcurrency(deps, 8, async (dep) => {
    const latest = await fetchLatest(dep.group, dep.artifact);
    if (!latest) return null;
    if (isPrerelease(latest) && !isPrerelease(dep.version)) return null;
    const outdated = compareVersions(dep.version, latest) < 0;
    return {
      group: dep.group,
      artifact: dep.artifact,
      current: dep.version,
      latest,
      outdated,
    };
  });
  return results.filter((r): r is OutdatedResult => r !== null);
}
