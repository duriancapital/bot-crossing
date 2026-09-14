/**
 * The frame gate: how often the colony is allowed to draw.
 *
 * This is the one piece of the pacing you cannot check by looking at it — "is the fan quieter"
 * is not a test — so the decision was kept pure and the interesting parts are here: that a cap
 * actually lands on its number rather than near it, that the remainder carries so 30 fps does
 * not decay into 27, and that going idle and coming back are both immediate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FrameGate, IDLE_AFTER_MS } from '../src/core/framerate.js'

/** A 120 Hz display: what the machine this was written for actually asks for. */
const TICK = 1000 / 120

/** Run `ms` worth of evenly spaced animation callbacks; returns how many were approved. */
function run(gate, ms, { from = 0, each } = {}) {
  let approved = 0
  const ticks = Math.round(ms / TICK)
  for (let i = 1; i <= ticks; i++) {
    const t = from + i * TICK
    if (gate.shouldRender(t)) approved++
    each?.(t)
  }
  return approved
}

// ── the cap ───────────────────────────────────────────────────────────────────

test('a 30 fps gate approves 30 of a second of 120 Hz ticks — one in four', () => {
  const gate = new FrameGate({ rate: 30, now: 0 })
  assert.equal(run(gate, 1000), 30)
})

test('the remainder carries: no drift over ten seconds', () => {
  const gate = new FrameGate({ rate: 30, now: 0 })
  // Anchoring each frame to the previous *delivery* rather than to when it was *due* loses
  // the sub-tick remainder every time, and 30 fps arrives as 24 — one frame per 4 ticks plus
  // change. Ten seconds is long enough for that to be unmistakable.
  assert.equal(run(gate, 10000), 300)
})

test('an awkward rate still averages out — 24 fps does not land on a 120 Hz tick evenly', () => {
  const gate = new FrameGate({ rate: 24, now: 0 })
  assert.equal(run(gate, 10000), 240)
})

test('rate 0 is uncapped — every tick is approved', () => {
  const gate = new FrameGate({ rate: 0, now: 0 })
  assert.equal(run(gate, 1000), Math.round(1000 / TICK))
})

test('a stall does not pay itself back in a burst of catch-up frames', () => {
  const gate = new FrameGate({ rate: 30, now: 0 })
  gate.shouldRender(0)
  // Two seconds of nothing — a hidden tab, or a machine that went to sleep.
  assert.equal(gate.shouldRender(2000), true)
  // The very next tick must not be approved: the schedule re-anchored to now rather than
  // trying to deliver the sixty frames it "owes".
  assert.equal(gate.shouldRender(2000 + TICK), false)
})

// ── idle ──────────────────────────────────────────────────────────────────────

test('the idle rate applies after 45 seconds without activity', () => {
  const gate = new FrameGate({ rate: 30, idleRate: 12, now: 0 })
  assert.equal(gate.rateAt(0), 30)
  assert.equal(gate.rateAt(IDLE_AFTER_MS - 1), 30)
  assert.equal(gate.rateAt(IDLE_AFTER_MS), 12)

  // And it is the rate actually delivered, not just the one reported.
  const second = run(gate, 1000, { from: IDLE_AFTER_MS })
  assert.equal(second, 12)
})

test('an unfocused window is idle immediately, however recently it was touched', () => {
  const gate = new FrameGate({ rate: 60, idleRate: 6, now: 0 })
  gate.noteActivity(0)
  gate.setFocused(false)
  assert.equal(gate.rateAt(0), 6)
  assert.equal(run(gate, 1000), 6)
})

test('focus and activity are one idea: either one on its own is not enough to wake it', () => {
  const gate = new FrameGate({ rate: 60, idleRate: 6, now: 0 })
  gate.setFocused(false)
  gate.noteActivity(1000) // a mouse crossing a background window is not somebody watching
  assert.equal(gate.rateAt(1000), 6)
  gate.setFocused(true)
  assert.equal(gate.rateAt(1000), 60)
  // Focused but untouched for the whole window is idle again.
  assert.equal(gate.rateAt(1000 + IDLE_AFTER_MS), 6)
})

test('activity restores the active rate at once — the next tick renders', () => {
  const gate = new FrameGate({ rate: 60, idleRate: 6, now: 0 })
  let t = IDLE_AFTER_MS
  assert.equal(gate.rateAt(t), 6)
  gate.shouldRender(t) // an idle frame; the next one would be 167ms out
  t += TICK
  assert.equal(gate.shouldRender(t), false)

  gate.noteActivity(t)
  // No waiting out the idle interval that was already pending: the schedule rebases onto the
  // rate that applies now, which is what stops the first flick of the mouse feeling stuck.
  assert.equal(gate.shouldRender(t + TICK), true)
})

// ── changing the rate while it runs ───────────────────────────────────────────

test('raising the cap mid-run takes effect on the next decision', () => {
  const gate = new FrameGate({ rate: 24, now: 0 })
  gate.shouldRender(100)
  assert.equal(gate.shouldRender(100 + TICK), false)
  gate.setRate(0)
  assert.equal(gate.shouldRender(100 + 2 * TICK), true)
})

test('lowering the cap mid-run slows the very next frame, not the one after', () => {
  const gate = new FrameGate({ rate: 60, now: 0 })
  gate.shouldRender(100)
  gate.setRate(24)
  // 60 fps had the next frame due at ~116ms; at 24 it is not due until ~141ms.
  assert.equal(gate.shouldRender(120), false)
  assert.equal(gate.shouldRender(142), true)
})

test('a settled rate change keeps its new number exactly', () => {
  const gate = new FrameGate({ rate: 30, now: 0 })
  run(gate, 1000)
  gate.setRate(60)
  assert.equal(run(gate, 1000, { from: 1000 }), 60)
})
