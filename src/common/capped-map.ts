/**
 * Sets a key, forgetting the oldest entry once the map holds `max`.
 *
 * For the per-session memos keyed by event or address: a long session
 * through a busy timeline would otherwise grow them without end. Insertion
 * order is the age; a forgotten entry is simply computed again.
 */
export function setCapped<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
): void {
  if (!map.has(key) && map.size >= max) {
    const oldest: K | undefined = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
