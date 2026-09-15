/**
 * The URL as a control surface.
 *
 * This is the only configuration a wallpaper ever gets: there is no keyboard behind the
 * desktop and no panel to correct a mistake in, so the table of what is accepted has to be
 * exactly right, and — the part worth testing hardest — a value that is *not* accepted has
 * to fall through silently rather than take the colony down with it. Every case below is a
 * URL somebody could plausibly type by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseQuery } from '../src/core/query.js'
import { PRESETS } from '../src/core/settings.js'

/** The ids `world/planet.js` defines. Passed in, because that module imports three.js. */
const PLANETS = ['moon', 'mars', 'terra']

const parse = (search) => parseQuery(search, PLANETS)

// ── nothing asked for ─────────────────────────────────────────────────────────

test('an empty query overrides nothing', () => {
  assert.deepEqual(parse(''), { wallpaper: false, settings: {} })
  assert.deepEqual(parse('?'), { wallpaper: false, settings: {} })
})

test('a missing or non-string search is the same as an empty one', () => {
  assert.deepEqual(parseQuery(undefined, PLANETS), { wallpaper: false, settings: {} })
  assert.deepEqual(parseQuery(null, PLANETS), { wallpaper: false, settings: {} })
  assert.deepEqual(parseQuery({}, PLANETS), { wallpaper: false, settings: {} })
})

test('the leading question mark is optional', () => {
  assert.deepEqual(parse('preset=low').settings, { preset: 'low' })
})

test('unknown keys are ignored rather than passed through', () => {
  assert.deepEqual(parse('?colour=blue&preset=low&shadows=ultra').settings, { preset: 'low' })
})

// ── preset ────────────────────────────────────────────────────────────────────

test('preset takes any named preset', () => {
  for (const name of Object.keys(PRESETS)) {
    assert.equal(parse(`?preset=${name}`).settings.preset, name)
  }
})

test('a preset that does not exist is ignored', () => {
  assert.deepEqual(parse('?preset=turbo').settings, {})
  // 'custom' is what the panel calls a preset you have edited, not one you can ask for.
  assert.deepEqual(parse('?preset=custom').settings, {})
  assert.deepEqual(parse('?preset=').settings, {})
})

// ── frame pacing ──────────────────────────────────────────────────────────────

test('fps accepts exactly what the settings panel offers', () => {
  for (const fps of [24, 30, 60, 0]) {
    assert.equal(parse(`?fps=${fps}`).settings.maxFps, fps)
  }
})

test('idle accepts exactly what the settings panel offers', () => {
  for (const idle of [6, 12, 20, 0]) {
    assert.equal(parse(`?idle=${idle}`).settings.idleFps, idle)
  }
})

test('a frame rate off the list is ignored, not clamped', () => {
  for (const search of ['?fps=45', '?fps=120', '?fps=-30', '?fps=abc', '?fps=']) {
    assert.deepEqual(parse(search).settings, {}, search)
  }
  for (const search of ['?idle=1', '?idle=15', '?idle=60', '?idle=nope', '?idle=']) {
    assert.deepEqual(parse(search).settings, {}, search)
  }
})

// ── planet ────────────────────────────────────────────────────────────────────

test('planet takes an id from the list it was given', () => {
  for (const id of PLANETS) assert.equal(parse(`?planet=${id}`).settings.planet, id)
})

test('a planet nobody has built is ignored', () => {
  assert.deepEqual(parse('?planet=jupiter').settings, {})
  assert.deepEqual(parse('?planet=Moon').settings, {})
  assert.deepEqual(parse('?planet=').settings, {})
  // No list, no planets — the caller is the only authority on what exists.
  assert.deepEqual(parseQuery('?planet=moon').settings, {})
})

// ── time of day ───────────────────────────────────────────────────────────────

test('time=live hands the sky to the machine clock', () => {
  assert.deepEqual(parse('?time=live').settings, { clockTime: true, autoTime: false })
})

test('a numeric time pins the sky and switches both cycles off', () => {
  assert.deepEqual(parse('?time=0.5').settings, { timeOfDay: 0.5, clockTime: false, autoTime: false })
  // Midnight is 0, which is exactly the value a lazier parser would drop as falsy.
  assert.deepEqual(parse('?time=0').settings, { timeOfDay: 0, clockTime: false, autoTime: false })
  assert.equal(parse('?time=1').settings.timeOfDay, 1)
  assert.equal(parse('?time=.32').settings.timeOfDay, 0.32)
})

test('a time outside the day, or not a time at all, is ignored', () => {
  for (const search of ['?time=1.5', '?time=-0.2', '?time=noon', '?time=', '?time=now']) {
    assert.deepEqual(parse(search).settings, {}, search)
  }
})

// ── hud and orbit ─────────────────────────────────────────────────────────────

test('hud and orbit are 0/1 switches', () => {
  assert.equal(parse('?hud=0').hud, false)
  assert.equal(parse('?hud=1').hud, true)
  assert.equal(parse('?orbit=0').orbit, false)
  assert.equal(parse('?orbit=1').orbit, true)
})

test('anything other than 0 or 1 leaves the switch alone', () => {
  for (const search of ['?hud=true', '?hud=yes', '?hud=', '?orbit=on', '?orbit=2']) {
    assert.equal('hud' in parse(search), false, search)
    assert.equal('orbit' in parse(search), false, search)
  }
})

// ── wallpaper ─────────────────────────────────────────────────────────────────

test('wallpaper is a flag: bare, or with a value', () => {
  assert.equal(parse('?wallpaper').wallpaper, true)
  assert.equal(parse('?wallpaper=').wallpaper, true)
  assert.equal(parse('?wallpaper=1').wallpaper, true)
  // Parked rather than deleted, so the rest of a long URL can stay as it is.
  assert.equal(parse('?wallpaper=0').wallpaper, false)
})

test('wallpaper implies no panels and a slow orbit', () => {
  assert.deepEqual(parse('?wallpaper'), { wallpaper: true, hud: false, orbit: true, settings: {} })
})

test('wallpaper=0 implies nothing', () => {
  assert.deepEqual(parse('?wallpaper=0'), { wallpaper: false, settings: {} })
})

test('an explicit switch beats the implication', () => {
  // Pointing a real browser window at the wallpaper's own URL, to see what it is up to.
  assert.deepEqual(parse('?wallpaper&hud=1'), { wallpaper: true, hud: true, orbit: true, settings: {} })
  assert.deepEqual(parse('?wallpaper&orbit=0'), { wallpaper: true, hud: false, orbit: false, settings: {} })
})

test('wallpaper does not touch any setting by itself', () => {
  assert.deepEqual(parse('?wallpaper').settings, {})
})

// ── the whole thing ───────────────────────────────────────────────────────────

test('the URL a wallpaper would actually be given', () => {
  const view = parse('?wallpaper&preset=low&fps=24&idle=6&planet=mars&time=live')
  assert.deepEqual(view, {
    wallpaper: true,
    hud: false,
    orbit: true,
    settings: { preset: 'low', maxFps: 24, idleFps: 6, planet: 'mars', clockTime: true, autoTime: false },
  })
})

test('one bad parameter costs only itself', () => {
  const view = parse('?wallpaper&preset=lowish&fps=45&idle=6&planet=mars&time=teatime&hud=maybe')
  assert.deepEqual(view, {
    wallpaper: true,
    hud: false,
    orbit: true,
    settings: { idleFps: 6, planet: 'mars' },
  })
})
