/**
 * Every knob that costs frames, in one place.
 *
 * Settings are a flat object so they serialise straight to localStorage, and everything
 * that reads them subscribes rather than polling — a change fires `onChange` with the set
 * of keys that moved, so the renderer can rebuild only what actually needs rebuilding.
 */

const STORE_KEY = 'botcrossing.settings.v1'

/**
 * What a fresh install opens on. Fixed rather than guessed from the device: `autoQuality`
 * scales the render buffer *under* whichever preset is chosen, so a slow machine is caught
 * by the governor within a second or two — which it does by measuring actual frame times
 * rather than by inferring speed from core counts.
 *
 * Only ever used when nothing is stored. An explicit choice always wins.
 */
export const DEFAULT_PRESET = 'balanced'

export const PRESETS = {
  potato: {
    label: 'Potato',
    hint: 'battery first — flat light, no extras',
    values: {
      renderScale: 0.5,
      shadows: 'off',
      bloom: false,
      antialias: false,
      particles: 'off',
      textureQuality: 'low',
      scatterDensity: 0.15,
      groundDetail: 'low',
      maxAgents: 40,
      stars: false,
      ibl: false,
      tiltShift: false,
    },
  },
  low: {
    label: 'Low',
    hint: 'for when you are on the go',
    values: {
      renderScale: 0.7,
      shadows: 'off',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'low',
      scatterDensity: 0.35,
      groundDetail: 'low',
      maxAgents: 60,
      stars: true,
      ibl: false,
      tiltShift: false,
    },
  },
  balanced: {
    label: 'Balanced',
    hint: 'the default — looks good, runs cool',
    values: {
      renderScale: 1,
      shadows: 'low',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'medium',
      scatterDensity: 0.6,
      groundDetail: 'medium',
      maxAgents: 90,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
  high: {
    label: 'High',
    hint: 'sharp shadows and a full sky',
    values: {
      renderScale: 1,
      shadows: 'high',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'high',
      scatterDensity: 0.85,
      groundDetail: 'high',
      maxAgents: 140,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
  ultra: {
    label: 'Ultra',
    hint: 'everything on, plugged in',
    values: {
      renderScale: 1.5,
      shadows: 'ultra',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'ultra',
      scatterDensity: 1,
      groundDetail: 'high',
      maxAgents: 200,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
}

export const SHADOW_SIZES = { off: 0, low: 1024, high: 2048, ultra: 4096 }
const TEXTURE_SIZES = { low: 256, medium: 512, high: 1024, ultra: 1024 }
const PARTICLE_BUDGET = { off: 0, low: 900, full: 3000 }

/**
 * The largest `maxAgents` any preset asks for. Anything sized once at boot — the badge buffers,
 * which are never rebuilt — allocates against this rather than against whatever preset happened
 * to be active, so raising quality later cannot outrun a buffer.
 */
export const MAX_AGENT_CAP = Math.max(...Object.values(PRESETS).map((p) => p.values.maxAgents || 0))

const DEFAULTS = {
  preset: 'balanced',
  ...PRESETS.balanced.values,

  // World
  planet: 'moon',
  /**
   * Fold away repos where every thread has been quiet for three days. On by default: with
   * several harnesses read at once the map otherwise fills with every checkout you have ever
   * opened, and the few repos actually being worked in get lost among them. It is reversible in
   * one click and a folded repo returns to the same ground the moment a thread wakes up.
   */
  hideDormant: true,
  timeOfDay: 0.32, // 0..1 — 0 is midnight, 0.5 is noon
  autoTime: false,
  /** Sky follows this machine's own clock. Wins over `autoTime`; both off is manual. */
  clockTime: false,
  dayLength: 240, // seconds for a full cycle when autoTime is on

  // Look
  exposure: 1.0,
  bloomStrength: 0.25,
  tiltShiftStrength: 0.2, // 0..1 — share of the effect's full blur radius (2% of frame height)
  tiltShiftAngle: 0, // degrees — 0 keeps the sharp band horizontal
  iblIntensity: 1.0,
  fov: 38,

  // Behaviour
  autoQuality: true, // drop render scale when frames get expensive
  /**
   * Frame pacing. Deliberately absent from every preset's `values`, which is what keeps
   * `set()` from flipping the preset to 'custom': how often the colony draws is not a
   * statement about how good it should look, and someone on Ultra who caps the rate is
   * still on Ultra.
   *
   * 30 rather than the display's refresh by default because this is a thing you glance at.
   * `maxFps: 0` means "whatever the display asks for", which is what it used to do always.
   */
  maxFps: 30, // 24 | 30 | 60 | 0 (display refresh)
  idleFps: 12, // 6 | 12 | 20 | 0 (same as maxFps) — after 45s untouched, or window unfocused
  autoFrame: false, // ease the camera back to isometric when you stop dragging; opt-in
  showFps: false,
  showLabels: true,
  reducedMotion: false,
}

/** Keys whose change forces a full rebuild of the world (terrain, scatter, sky). */
const WORLD_KEYS = new Set(['planet', 'groundDetail', 'scatterDensity', 'stars'])
/** Keys that only need the renderer reconfigured. */
const RENDER_KEYS = new Set([
  'renderScale',
  'shadows',
  'bloom',
  'antialias',
  'exposure',
  'bloomStrength',
  'tiltShift',
  'tiltShiftStrength',
  'tiltShiftAngle',
])

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() }
    this.listeners = new Set()
    this._saveTimer = 0
    /**
     * Keys the URL took over for this page view, each holding the value that *would* have
     * been in use without it. See `applySession` — this is the whole of the mechanism.
     */
    this._session = {}
  }

  get(key) {
    return this.values[key]
  }

  /** True when `key` currently differs from what the active preset specifies. */
  isOverridden(key) {
    const preset = PRESETS[this.values.preset]
    return Boolean(preset && key in preset.values && preset.values[key] !== this.values[key])
  }

  set(key, value) {
    if (this.values[key] === value) return
    this.values[key] = value
    // Touching any quality knob directly means you are no longer on a named preset.
    const preset = PRESETS[this.values.preset]
    if (preset && key in preset.values) this.values.preset = 'custom'
    this._emit([key])
  }

  applyPreset(name) {
    const preset = PRESETS[name]
    if (!preset) return
    const changed = []
    for (const [k, v] of Object.entries(preset.values)) {
      if (this.values[k] !== v) {
        this.values[k] = v
        changed.push(k)
      }
    }
    this.values.preset = name
    this._emit(changed.length ? changed : ['preset'])
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit(keys, session = false) {
    const changed = new Set(keys)
    const scope = {
      world: keys.some((k) => WORLD_KEYS.has(k)),
      render: keys.some((k) => RENDER_KEYS.has(k)),
      /** True when this change came from the URL and must not be written anywhere. */
      session,
    }
    for (const fn of this.listeners) fn(changed, scope, this.values)
    if (!session) this._scheduleSave()
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.saveValues))
      } catch {
        /* private mode, quota — the game just forgets between sessions */
      }
    }, 400)
  }

  /**
   * Adopt a whole saved set at once — the colony file's copy, when this browser has none of
   * its own. One emit rather than one per key, so the renderer is reconfigured once instead
   * of thirty times on the way in.
   */
  applyAll(values) {
    const changed = []
    for (const [key, value] of Object.entries(values || {})) {
      if (!(key in this.values)) continue
      // A key the URL claimed keeps the URL's answer on screen, but still records the file's
      // — so the colony file's own taste survives being looked at through a wallpaper.
      if (key in this._session) {
        this._session[key] = value
        continue
      }
      if (this.values[key] === value) continue
      this.values[key] = value
      changed.push(key)
    }
    if (changed.length) this._emit(changed)
    return changed.length
  }

  /**
   * Adopt values for this page view only. They take effect exactly like any other change —
   * the renderer reconfigures, the world rebuilds — but they are never written back.
   *
   * WHY: one server, two very different windows. The colony is opened in an ordinary browser
   * tab *and*, on a side monitor, as a desktop wallpaper whose URL says what that screen
   * should be: low preset, six frames a second, no panels. Settings are shared between the
   * two — localStorage per origin, and the colony file's `settings` block across origins —
   * so if the wallpaper's choices were saved they would become the browser's, and the next
   * tab you opened by hand would come up dark, crawling and stripped of its HUD, with nothing
   * on screen to explain why. So the value each key had *before* the URL touched it is kept
   * here, and that is what every later save writes: the wallpaper borrows the settings, it
   * does not get to keep them.
   *
   * `preset` is expanded rather than stored as a name, since a preset is its values.
   */
  applySession(values) {
    const incoming = { ...(values || {}) }
    const preset = PRESETS[incoming.preset]
    if (preset) Object.assign(incoming, preset.values)
    else delete incoming.preset
    const changed = []
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in this.values)) continue
      // Once per key, and before the write: the first reading is the one worth keeping.
      if (!(key in this._session)) this._session[key] = this.values[key]
      if (this.values[key] === value) continue
      this.values[key] = value
      changed.push(key)
    }
    if (changed.length) this._emit(changed, true)
    return changed.length
  }

  /** The settings as they should be *stored*: live values with any URL override wound back. */
  get saveValues() {
    return { ...this.values, ...this._session }
  }

  // Convenience readers used all over the render code.
  get shadowSize() {
    return SHADOW_SIZES[this.values.shadows] || 0
  }
  get textureSize() {
    return TEXTURE_SIZES[this.values.textureQuality] || 512
  }
  get particleBudget() {
    return PARTICLE_BUDGET[this.values.particles] ?? 0
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function hasStoredSettings() {
  try {
    return Boolean(localStorage.getItem(STORE_KEY))
  } catch {
    return false
  }
}
