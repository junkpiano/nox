/**
 * One query, several relays, and the decision of when to stop waiting.
 *
 * Every multi-relay read has the same shape: open the same subscription on
 * each relay, collect what arrives, return once enough relays have finished.
 * "Enough" is the whole question. Wait for all of them and one dead relay
 * costs its full timeout on every load - that is how a fresh key spent most
 * of a minute learning it followed nobody. Return on the first and a relay
 * that is merely slower never gets to contribute.
 *
 * The rule here: once one relay has genuinely answered (EOSE), the rest get a
 * short grace period, then the query returns with what it has. A relay that
 * failed or closed does not start that clock; it has said nothing about how
 * long a real answer takes. A caller that needs every relay's word - one
 * about to republish a list, say - asks for no grace and waits for each relay
 * to answer or give up on its own.
 */

export interface RelayReport {
  /** The relay sent EOSE: it has said everything it has. */
  answered(): void;
  /** The relay failed, closed, or timed out without answering. */
  gaveUp(): void;
}

export interface FanoutOptions {
  /**
   * How long the remaining relays get once one has answered. Omit to wait
   * for every relay to answer or give up.
   */
  stragglerGraceMs?: number;
}

export interface FanoutResult {
  /** Relays that reached EOSE before the query returned. */
  answered: string[];
}

/**
 * Runs `open` on every relay and resolves once enough of them have finished.
 *
 * `open` starts the query and resolves to a function that stops it - closing
 * the subscription and clearing any timer it set. It reports through
 * `report`, and each relay is counted once whichever way it finishes: a relay
 * that sends EOSE and then CLOSED, or EOSE twice, does not bring the query
 * to an early end. A relay is stopped as soon as it has reported, and a stop
 * function that arrives after the query has returned is called on the spot,
 * so a late connection does not leave a subscription open behind it.
 */
export function fanOut(
  relays: string[],
  open: (relayUrl: string, report: RelayReport) => Promise<() => void>,
  options: FanoutOptions = {},
): Promise<FanoutResult> {
  // A relay listed twice is one relay; counting it twice would leave the
  // query waiting for a second answer that never comes.
  const targets: string[] = Array.from(new Set(relays));

  return new Promise<FanoutResult>((resolve) => {
    const stops: Map<string, () => void> = new Map();
    const finished: Set<string> = new Set();
    const answered: string[] = [];
    let settled: boolean = false;
    let grace: ReturnType<typeof setTimeout> | null = null;

    const stopQuietly = (stop: () => void): void => {
      try {
        stop();
      } catch {
        // Already gone.
      }
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (grace !== null) clearTimeout(grace);
      for (const stop of stops.values()) stopQuietly(stop);
      stops.clear();
      resolve({ answered: [...answered] });
    };

    /** Marks the relay finished and stops it. False when it already had. */
    const finishRelay = (relayUrl: string): boolean => {
      if (settled || finished.has(relayUrl)) return false;
      finished.add(relayUrl);
      const stop: (() => void) | undefined = stops.get(relayUrl);
      if (stop) {
        stops.delete(relayUrl);
        stopQuietly(stop);
      }
      return true;
    };

    const reportFor = (relayUrl: string): RelayReport => ({
      answered: (): void => {
        if (!finishRelay(relayUrl)) return;
        answered.push(relayUrl);
        if (finished.size >= targets.length) {
          finish();
          return;
        }
        if (grace === null && options.stragglerGraceMs !== undefined) {
          grace = setTimeout(finish, options.stragglerGraceMs);
        }
      },
      gaveUp: (): void => {
        if (!finishRelay(relayUrl)) return;
        if (finished.size >= targets.length) finish();
      },
    });

    for (const relayUrl of targets) {
      const report: RelayReport = reportFor(relayUrl);
      let opened: Promise<() => void>;
      try {
        opened = open(relayUrl, report);
      } catch {
        report.gaveUp();
        continue;
      }
      opened
        .then((stop: () => void): void => {
          if (settled || finished.has(relayUrl)) {
            stopQuietly(stop);
            return;
          }
          stops.set(relayUrl, stop);
        })
        .catch((): void => {
          report.gaveUp();
        });
    }

    if (targets.length === 0) finish();
  });
}
