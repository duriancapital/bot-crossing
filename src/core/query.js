/**
 * The URL as a control surface — what a screen with no keyboard on it can still be told.
 *
 * The colony is meant to be left running on a side monitor, and on macOS that means Plash:
 * a URL rendered in a WKWebView *behind* the desktop, on a display you pick, with no
 * keyboard and normally no mouse. Nothing in the HUD can be reached from there, so the
 * choices that view needs — quality, pacing, which planet, what time of day, panels gone —
 * have to arrive with the page itself.
 *
 * Deliberately pure: a string in, a plain object out. No DOM, no three.js, no settings
 * instance — which is what makes the whole parameter table testable, and what keeps the one
 * rule that matters honest: a bad value is never an error, it is simply not an override.
 * A wallpaper that failed to start because somebody fat-fingered `fps=45` would be a worse
 * bug than one that quietly ran at 30.
 */

import { PRESETS } from './settings.js'

/** Exactly the choices the settings panel offers. The URL is not a back door to more. */
const FPS_VALUES = new Set([24, 30, 60, 0])
const IDLE_VALUES = new Set([6, 12, 20, 0])

/**
 * @param {string} search a `location.search`-style string, with or without its leading `?`
 * @param {string[]} [planetIds] the ids `PLANETS` knows about — passed in rather than
 *   imported, because `world/planet.js` pulls in three.js and this module must stay loadable
 *   under plain node
 * @returns {{wallpaper: boolean, hud?: boolean, orbit?: boolean, settings: object}}
 *   `settings` holds only keys that were actually asked for, ready for `Settings#applySession`
 */
export function parseQuery(search, planetIds = []) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '')
  const out = { wallpaper: false, settings: {} }

  // Presence is the signal — `?wallpaper` with no value is how you would write it by hand —
  // with `=0` left as a way to park the flag in a URL without deleting it.
  if (params.has('wallpaper')) out.wallpaper = params.get('wallpaper') !== '0'

  const preset = params.get('preset')
  if (preset && Object.hasOwn(PRESETS, preset)) out.settings.preset = preset

  const fps = num(params.get('fps'))
  if (fps !== null && FPS_VALUES.has(fps)) out.settings.maxFps = fps

  const idle = num(params.get('idle'))
  if (idle !== null && IDLE_VALUES.has(idle)) out.settings.idleFps = idle

  const planet = params.get('planet')
  if (planet && planetIds.includes(planet)) out.settings.planet = planet

  applyTime(params.get('time'), out.settings)

  const hud = bit(params.get('hud'))
  if (hud !== null) out.hud = hud

  const orbit = bit(params.get('orbit'))
  if (orbit !== null) out.orbit = orbit

  // What `wallpaper` is shorthand for. Implications only: an explicit `hud=1` still wins, so
  // you can point a normal browser window at the wallpaper's own URL to see what it is doing.
  if (out.wallpaper) {
    if (out.hud === undefined) out.hud = false
    if (out.orbit === undefined) out.orbit = true
  }

  return out
}

/**
 * `live` hands the sky to this machine's clock; a number pins it. Either way the other two
 * time modes are switched off, because a fixed time that quietly drifts back into a day
 * cycle is not a fixed time — and an unattended screen has nobody there to notice.
 */
function applyTime(raw, settings) {
  if (raw === null) return
  if (raw === 'live') {
    settings.clockTime = true
    settings.autoTime = false
    return
  }
  const value = num(raw)
  if (value === null || value < 0 || value > 1) return
  settings.timeOfDay = value
  settings.clockTime = false
  settings.autoTime = false
}

/** A finite number, or null. `Number('')` is 0, which would make an empty value mean midnight. */
function num(raw) {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** A 0/1 switch. Anything else is a typo, and a typo is not an instruction. */
function bit(raw) {
  if (raw === '0') return false
  if (raw === '1') return true
  return null
}
