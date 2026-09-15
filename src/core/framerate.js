/**
 * Frame pacing — how often the colony is allowed to draw, as opposed to how well.
 *
 * On a fast GPU the quality knobs are the wrong lever. `setAnimationLoop` runs at the
 * display's refresh rate, so a ProMotion panel asks for 120 frames a second and a machine
 * that never misses one simply burns 120 frames' worth of power forever. Halving the render
 * scale there buys a little heat back and costs the whole look; drawing 30 frames instead of
 * 120 costs nothing anyone can see on a colony that is meant to be *glanced at* on a second
 * monitor, and it is a straight 4× cut in everything a frame costs — geometry, bloom, the
 * depth-of-field passes, the lot.
 *
 * This class is the decision and nothing else: no DOM, no timers, no settings. It is told
 * the time and whether anything has happened lately, and answers yes or no. That is what
 * makes the pacing testable rather than something you can only judge by watching a fan.
 */

/**
 * How long the colony goes untouched before it drops to its idle rate. A constant rather
 * than a setting: it is the definition of "nobody is looking", not a preference.
 */
export const IDLE_AFTER_MS = 45000

/**
 * Timestamps from `requestAnimationFrame` jitter by a millisecond or two, and a cap at or
 * near the display's own rate lands frames a hair *before* they are due. Without a little
 * slack every such frame is refused and waits a whole extra tick, which turns a 60 fps cap
 * on a 60 Hz panel into 30. The schedule still advances by a whole interval either way, so
 * the slack cannot make the average rate run fast.
 */
const SLACK_MS = 2

const normalise = (fps) => {
  const n = Number(fps)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export class FrameGate {
  /**
   * @param {object} [options]
   * @param {number} [options.rate] frames per second while in use; 0 means uncapped
   * @param {number} [options.idleRate] frames per second while idle; 0 means uncapped
   * @param {number} [options.idleAfterMs] quiet time before the idle rate applies
   * @param {number} [options.now] the clock reading at construction
   * @param {boolean} [options.focused] whether the window has focus right now
   */
  constructor({ rate = 30, idleRate = 12, idleAfterMs = IDLE_AFTER_MS, now = 0, focused = true } = {}) {
    this.idleAfterMs = idleAfterMs
    this._rate = normalise(rate)
    this._idleRate = normalise(idleRate)
    this._focused = focused !== false
    this._lastActivity = now
    /** When the last approved frame happened — what a rate change rebases the schedule off. */
    this._lastAt = now
    /** When the next frame is *due*. Advanced by whole intervals, never by "now + interval". */
    this._nextAt = now
    this._interval = null
    /** See `setUnattended`: a screen nobody is sitting at, whatever the window system says. */
    this._unattended = false
  }

  /**
   * Pin the gate to its idle rate for good.
   *
   * A wallpaper view is never being *looked at* in the sense this class means, and it cannot
   * be trusted to say so itself: the web view behind the desktop may well report focus, and
   * a mouse crossing that monitor on its way somewhere else is not somebody using the colony.
   * So the wallpaper declares it once at boot instead, and focus stops being an input.
   */
  setUnattended(on = true) {
    this._unattended = Boolean(on)
    if (this._unattended) this._focused = false
  }

  setRate(fps) {
    this._rate = normalise(fps)
  }

  setIdleRate(fps) {
    this._idleRate = normalise(fps)
  }

  setFocused(focused) {
    if (this._unattended) return
    this._focused = Boolean(focused)
  }

  /** Any pointer, wheel, key or touch. Resets the idle countdown. */
  noteActivity(nowMs) {
    this._lastActivity = nowMs
  }

  /**
   * Idle and unfocused share one rate on purpose. They are the same fact from two directions
   * — nobody is looking at this window — and splitting them would only add a third number to
   * a panel that already has enough of them.
   */
  isIdle(nowMs) {
    return !this._focused || nowMs - this._lastActivity >= this.idleAfterMs
  }

  /** Which of the two rates applies at `nowMs`. 0 means "as fast as the display asks". */
  rateAt(nowMs) {
    return this.isIdle(nowMs) ? this._idleRate : this._rate
  }

  /** Milliseconds between frames at the rate that currently applies; 0 when uncapped. */
  intervalAt(nowMs) {
    const rate = this.rateAt(nowMs)
    return rate > 0 ? 1000 / rate : 0
  }

  /** True when this animation callback should do the frame's work. */
  shouldRender(nowMs) {
    const interval = this.intervalAt(nowMs)
    // A rate change — the user picking a different cap, or the window going idle or waking —
    // rebases the schedule off the last frame that was let through, so it takes effect on
    // this decision rather than after the interval that happened to be pending.
    if (interval !== this._interval) {
      this._interval = interval
      this._nextAt = this._lastAt + interval
    }

    if (interval === 0) {
      this._lastAt = nowMs
      this._nextAt = nowMs
      return true
    }

    if (nowMs + SLACK_MS < this._nextAt) return false

    const late = nowMs - this._nextAt
    // Carry the remainder: the next frame is due one interval after the one that was *due*,
    // not one interval after the one that was *delivered*. Anchoring to delivery adds every
    // scheduling remainder to the period, and 30 fps quietly becomes 27 — on a 120 Hz panel
    // a 33.3 ms period only ever lands on a 41.7 ms tick.
    //
    // More than a whole interval late means a stall, a hidden tab, or a rate change: re-anchor
    // to now instead of paying back frames nobody was here to see.
    this._nextAt = late > interval ? nowMs + interval : this._nextAt + interval
    this._lastAt = nowMs
    return true
  }
}
