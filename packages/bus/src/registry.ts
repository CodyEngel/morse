/**
 * The entirety of what the bus knows about a registry.
 *
 * This interface is defined *here*, in the package that calls through it, and
 * `@morse-ai/registry` satisfies it structurally without importing anything.
 * Neither package depends on the other in either direction — which is what lets
 * you bring your own registry, backed by whatever you like, and what the
 * zero-dependency CI guard exists to protect.
 *
 * Four methods, and every one of them replaces a call the old Store already
 * made. Nothing was added for symmetry.
 */

export type Status = "idle" | "working" | "blocked" | "done" | "offline";

export interface Registry {
  /**
   * Note that `name` is alive right now.
   *
   * Called on every poll of a parked wait — roughly five times a second per
   * agent — so it must be cheap and must not throw. A registry that blocks here
   * slows down every agent's mail.
   */
  heartbeat(room: string, name: string): void | Promise<void>;

  /**
   * Who is addressable in `room`.
   *
   * Advisory: it drives a "not in this room" warning and never a refusal, so a
   * registry that returns nothing degrades to a bus with no warnings rather
   * than a bus that rejects mail.
   */
  names(room: string): string[] | Promise<string[]>;

  /**
   * This agent's current state, so a blocking wait can put back what it
   * displaced, and the state it should be moved to while blocked.
   *
   * These two are here for the *standalone* bus, not for morse-ai. They were
   * added for `morse_wait` on a thread, which captures a status, sets
   * `blocked`, and restores the original if no reply lands — and then that tool
   * moved to morse-ai, because it also answers with roster data this interface
   * deliberately cannot supply. morse-ai holds a concrete registry and calls it
   * directly, so the composed server no longer reaches for either of these.
   *
   * They stay because `morse-bus ask` is a real consumer: a bus used on its own
   * still has to be able to say it is blocked, and that is the whole point of
   * the package being independently usable. Dropping them would shrink the
   * interface by making the standalone story worse.
   *
   * The practical consequence for anyone implementing this: a registry that
   * only ever backs morse-ai can leave both as no-ops and lose nothing.
   */
  status(room: string, name: string): Status | undefined | Promise<Status | undefined>;

  setStatus(
    room: string,
    name: string,
    status: Status,
    note?: string | null,
  ): void | Promise<void>;
}

/**
 * Running with no registry at all, chosen explicitly.
 *
 * `registry` is a required constructor argument precisely so that this is
 * something you asked for rather than something you defaulted into. It gives up
 * exactly three things — presence (nobody is ever `online`), unknown-recipient
 * warnings, and status publication, so an agent parked in an ask no longer
 * shows as `blocked`.
 *
 * It keeps everything else, including the deadlock avoidance in `ask`: that is
 * driven by unrelated mail arriving in the inbox, and never consults status.
 */
export const unregistered: Registry = {
  heartbeat() {},
  names() {
    return [];
  },
  status() {
    return undefined;
  },
  setStatus() {},
};
