/**
 * Posts that are data, not words.
 *
 * Some kind:1 events are written by software for software: a presence
 * heartbeat, a serialised state object, a bot's log line in JSON. They are
 * valid notes and the relays carry them, and to a person reading a timeline
 * they are a card full of braces. The web app drew them; the phone drew them;
 * nobody wanted them.
 *
 * The test is narrow on purpose. A note whose whole content parses as a JSON
 * object or array is machine output - a person writing about JSON puts words
 * around it. Anything looser (a line that merely *looks* structured, a hex
 * blob, a bot's plain-text roster) is left alone: hiding prose by heuristic
 * is how a client starts eating posts it does not understand.
 */

/** True when the entire content is one JSON object or array. */
export function isMachineContent(content: string): boolean {
  const trimmed: string = content.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const first: string = trimmed[0] ?? '';
  const last: string = trimmed[trimmed.length - 1] ?? '';
  const looksStructured: boolean =
    (first === '{' && last === '}') || (first === '[' && last === ']');
  if (!looksStructured) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** Drops the machine-written posts, keeping order. */
export function withoutMachineContent<T extends { content: string }>(
  events: T[],
): T[] {
  return events.filter((event: T): boolean => !isMachineContent(event.content));
}
