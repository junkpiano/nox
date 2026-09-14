/**
 * Relay traffic, taken a little at a time.
 *
 * Checking a signature costs about a millisecond in a desktop browser and
 * about forty on a phone, and a timeline's worth of reactions, names and
 * statuses is hundreds of them. Handled as each message arrived, that was
 * seconds at a stretch with the one JavaScript thread busy - and a tap on a
 * post waits for that thread before it can open anything.
 *
 * So what the relays send is queued, and the queue is worked through in
 * slices: a few milliseconds of it, then the thread is handed back, then
 * more. A tap gets in between two events rather than behind all of them.
 *
 * Deferring delivery would, on its own, change what a query returns. Every
 * reader gives up on a relay after a while, and a timer firing while events
 * that arrived before it are still waiting here would cut those events off.
 * When the thread was simply blocked, the same events were handled before
 * the timer could run. `setRelayTimeout` keeps that order: a relay timer
 * that fires joins the back of this queue, behind everything received
 * before it.
 */

/** How long one slice may run before the thread is handed back. */
const SLICE_MS: number = 8;

interface Job {
  run: () => void;
  dropped: boolean;
  /**
   * Run only at the start of a slice. A reader's answer often travels
   * through promises, which settle once the slice that delivered it has
   * returned; a deadline acted on later in that same slice would get there
   * first. When the thread was blocked, every message ended its own task
   * and the answer always arrived before the deadline.
   */
  startsSlice: boolean;
}

const jobs: Job[] = [];
let head: number = 0;
let scheduled: boolean = false;

function clock(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(drain, 0);
}

function drain(): void {
  const started: number = clock();
  let ran: number = 0;
  try {
    while (head < jobs.length) {
      const job: Job | undefined = jobs[head];
      if (job && !job.dropped && job.startsSlice && ran > 0) break;
      head += 1;
      if (job && !job.dropped) {
        ran += 1;
        try {
          job.run();
        } catch (error: unknown) {
          // One reader failing is not a reason to stop delivering to the
          // rest, which is also what a throwing socket listener meant.
          console.error('[relay] a delivery failed', error);
        }
      }
      if (clock() - started >= SLICE_MS) break;
    }
  } finally {
    scheduled = false;
    if (head >= jobs.length) {
      jobs.length = 0;
      head = 0;
    } else {
      if (head >= 1024) {
        jobs.splice(0, head);
        head = 0;
      }
      schedule();
    }
  }
}

/** Runs `work` in its turn, after everything queued before it. */
export function enqueueRelayWork(work: () => void): void {
  jobs.push({ run: work, dropped: false, startsSlice: false });
  schedule();
}

export interface RelayTimeout {
  native: ReturnType<typeof setTimeout> | null;
  job: Job | null;
  cancelled: boolean;
}

/**
 * A timer for giving up on a relay, ordered with the relay's own traffic.
 *
 * When it fires it is queued rather than run, so events that arrived before
 * the deadline are delivered before the deadline is acted on.
 */
export function setRelayTimeout(
  callback: () => void,
  ms: number,
): RelayTimeout {
  const timer: RelayTimeout = { native: null, job: null, cancelled: false };
  timer.native = setTimeout((): void => {
    timer.native = null;
    if (timer.cancelled) return;
    const job: Job = { run: callback, dropped: false, startsSlice: true };
    timer.job = job;
    jobs.push(job);
    schedule();
  }, ms);
  return timer;
}

/** Cancels a relay timer, including one that has fired and is waiting. */
export function clearRelayTimeout(
  timer: RelayTimeout | null | undefined,
): void {
  if (!timer) return;
  timer.cancelled = true;
  if (timer.native !== null) {
    clearTimeout(timer.native);
    timer.native = null;
  }
  if (timer.job) timer.job.dropped = true;
}
