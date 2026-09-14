import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { SHADOW_SIZES } from './settings.js'
import { createTiltShift } from './tiltshift.js'
import { FrameGate } from './framerate.js'

/** Safari and friends — not Chrome, which also says "Safari" in its user agent. */
const IS_WEBKIT =
  typeof navigator !== 'undefined' &&
  /apple/i.test(navigator.vendor || '') &&
  !/chrome|chromium|edg\//i.test(navigator.userAgent || '')

/** What counts as somebody being here. Kept off the canvas: the panels are the colony too. */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart']

/** The largest step the simulation will take at once — see the note in `_loop`. */
const MAX_STEP = 0.2

const nowMs = () => performance.now()

/**
 * Renderer, post chain, and the frame loop.
 *
 * Two things here are load-bearing for performance:
 *
 * 1. **The post chain is built lazily and torn down when off.** With bloom disabled the
 *    composer is not merely skipped — it is disposed, so its float render targets stop
 *    costing memory and bandwidth. Turning HDR off on a weak machine has to actually
 *    give the memory back, not just stop drawing.
 * 2. **Render scale is separate from device pixel ratio.** `setPixelRatio` alone cannot go
 *    below 1 usefully on a retina panel, so the drawing buffer is sized directly. That is
 *    the single biggest lever there is, and it is what the auto-quality governor pulls.
 *
 *    The setting is a fraction of *the display's own resolution*, not of CSS pixels: 100%
 *    on a retina panel is 2 buffer pixels per CSS pixel. Reading it as CSS pixels is what
 *    the earlier version did, and it quietly rendered every retina machine at half
 *    resolution — text on the name plates and the badge glyphs magnify hardest, so they
 *    are where a soft buffer shows up first.
 * 3. **The loop is paced, not just governed.** `setAnimationLoop` asks for a frame at the
 *    display's refresh rate — 120 a second on a ProMotion panel — and the governor below
 *    only ever reacts to frames being *slow*. A fast machine is therefore never asked to do
 *    less: it draws 5.9 megapixels of HDR, bloom and depth of field 120 times a second at a
 *    window nobody is looking at. `FrameGate` is the missing half of that: it decides how
 *    *often* to draw, which is the lever that costs nothing visible on a colony you glance
 *    at, where cutting quality costs the whole point of it.
 */
export class Engine {
  constructor(settings) {
    this.settings = settings
    // Timer replaces the deprecated Clock. Connecting it to the document means a tab that
    // has been in the background reports a zero delta rather than one enormous catch-up
    // frame, so nothing in the colony teleports when you come back to it.
    this.timer = new THREE.Timer()
    this.timer.connect(document)
    this.elapsed = 0
    this.updaters = []
    this.running = false

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.5, 900)

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // handled by SMAA in the post chain, or not at all
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      /**
       * Off everywhere it can be: preserving the buffer costs a full copy on every frame,
       * forever, and the screenshot path already works around needing it.
       *
       * On WebKit it has to be on. Safari treats a window with another app in front of it
       * as *hidden*, stops driving `requestAnimationFrame`, and then composites the canvas
       * anyway — and a drawing buffer nobody has drawn into since the last composite is
       * transparent black. The symptom is the whole colony blinking out for a frame every
       * few seconds, but only while something is layered over the window, which is exactly
       * the case where nothing is repainting it.
       */
      preserveDrawingBuffer: IS_WEBKIT,
    })
    this.renderer.setPixelRatio(1) // the drawing buffer is sized by hand, see resize()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = settings.get('exposure')
    // PCFSoftShadowMap is deprecated and silently downgraded by three anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.info.autoReset = false

    this.canvas = this.renderer.domElement
    this.canvas.classList.add('bot-crossing-canvas')

    this.composer = null
    this.bloomPass = null
    this.smaaPass = null
    this.tiltShift = null
    /** How far the view is orbiting; the focal plane sits here. Fed by the frame loop. */
    this._focusDistance = 30

    this.perf = new PerfMonitor()
    this._boundLoop = this._loop.bind(this)
    this._onResize = () => this.resize()

    // Frame pacing. Focus starts as whatever the window actually has: a colony opened on a
    // second monitor while you keep typing somewhere else should start idle, not spend its
    // first 45 seconds at the full rate.
    this.gate = new FrameGate({
      now: nowMs(),
      focused: typeof document !== 'undefined' ? document.hasFocus() : true,
    })
    this._applyFrameRate()
    // The rates are read through the ordinary settings subscription rather than per frame, so
    // picking another cap in the panel takes hold on the next animation callback.
    this._unsubscribe = settings.onChange((changed) => {
      if (changed.has('maxFps') || changed.has('idleFps')) this._applyFrameRate()
    })

    this.applySettings()
  }

  /** Idle rate 0 means "same as the frame rate" — one fewer number to reason about. */
  _applyFrameRate() {
    const max = Number(this.settings.get('maxFps')) || 0
    const idle = Number(this.settings.get('idleFps')) || 0
    this.gate.setRate(max)
    this.gate.setIdleRate(idle > 0 ? idle : max)
  }

  mount(parent) {
    parent.appendChild(this.canvas)
    window.addEventListener('resize', this._onResize)
    // A window dragged between a retina and a non-retina display changes DPR with no resize.
    this._dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this._dprQuery.addEventListener?.('change', this._onResize)
    // A page that loads in a background tab has a zero-width parent and no `resize` event
    // coming, which would leave a one-pixel drawing buffer until the window happened to
    // move. The observer fires the moment the element is actually laid out.
    this._observer = new ResizeObserver(this._onResize)
    this._observer.observe(parent)

    // Coming back from hidden — a tab switch, or another window moving off this one — the
    // compositor can ask for the canvas before the frame loop has run once. Drawing here
    // rather than waiting for the next animation frame is what stops that moment being a
    // black flash.
    this._onWake = () => {
      if (document.hidden || !this.running) return
      this.resize()
      this.renderFrame()
    }
    document.addEventListener('visibilitychange', this._onWake)
    window.addEventListener('focus', this._onWake)
    window.addEventListener('pageshow', this._onWake)

    // What the frame gate calls "being looked at". Focus is the strong signal — a window
    // behind another app is not being watched even if the mouse crossed it a second ago —
    // and the input listeners are what keep the rate up while you are actually using it.
    // Hidden tabs are already handled: `setAnimationLoop` simply stops being called.
    this._onFocus = () => {
      this.gate.setFocused(true)
      this.gate.noteActivity(nowMs())
    }
    this._onBlur = () => this.gate.setFocused(false)
    this._onActivity = () => this.gate.noteActivity(nowMs())
    window.addEventListener('focus', this._onFocus)
    window.addEventListener('blur', this._onBlur)
    // Passive: none of these are ever cancelled, and saying so keeps scrolling off the
    // main thread's critical path.
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, this._onActivity, { passive: true })

    this.resize()
    return this
  }

  add(updater) {
    this.updaters.push(updater)
    return updater
  }

  /** Rebuilds only what a settings change actually invalidated. */
  applySettings() {
    const s = this.settings
    const renderer = this.renderer

    const size = SHADOW_SIZES[s.get('shadows')] || 0
    renderer.shadowMap.enabled = size > 0
    // A shadow map that changes size has to be thrown away or three keeps the old target.
    if (this._shadowSize !== size) {
      this._shadowSize = size
      this.scene.traverse((o) => {
        if (o.isLight && o.shadow?.map) {
          o.shadow.map.dispose()
          o.shadow.map = null
          if (size) o.shadow.mapSize.setScalar(size)
        }
      })
      renderer.shadowMap.needsUpdate = true
    }

    renderer.toneMappingExposure = s.get('exposure')
    this.camera.fov = s.get('fov')
    this.camera.updateProjectionMatrix()

    const wantsPost = s.get('bloom') || s.get('antialias') || s.get('tiltShift')
    if (wantsPost) this._ensureComposer()
    else this._disposeComposer()

    if (this.composer) {
      if (this.bloomPass) {
        this.bloomPass.enabled = s.get('bloom')
        this.bloomPass.strength = s.get('bloomStrength')
      }
      if (this.smaaPass) this.smaaPass.enabled = s.get('antialias')
      if (this.tiltShift) {
        this.tiltShift.enabled = s.get('tiltShift')
        this.tiltShift.setStrength(s.get('tiltShiftStrength'))
        this.tiltShift.setAngle(s.get('tiltShiftAngle'))
        this.tiltShift.setCamera(this.camera)
      }
    }

    this.resize()
  }

  _ensureComposer() {
    if (this.composer) return
    // A depth texture on the target is what lets tilt-shift be a real depth of field rather
    // than a screen-space smear. It costs one attachment, where asking three's own BokehPass
    // for the same thing costs a second pass over the entire scene.
    const depthTexture = new THREE.DepthTexture(1, 1)
    depthTexture.type = THREE.UnsignedIntType
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR: values above 1 survive to the bloom pass
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    })
    const composer = new EffectComposer(this.renderer, target)
    composer.addPass(new RenderPass(this.scene, this.camera))

    // A high threshold is what keeps this an accent rather than a haze: only the eyes,
    // lamps, sparks and the sun's disc clear it, so lit surfaces stay crisp.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.settings.get('bloomStrength'), 0.55, 0.92)
    composer.addPass(this.bloomPass)

    // After bloom, so an out-of-focus lamp keeps its glow and the glow goes soft with it
    // — blurring first would drop those pixels under the bloom threshold and switch the
    // glow off exactly where the eye expects the most of it. Still before OutputPass, so
    // the blur averages linear HDR values rather than tone-mapped ones.
    this.tiltShift = createTiltShift()
    for (const pass of this.tiltShift.passes) composer.addPass(pass)
    // RenderPass and the bloom pass both leave their result in the composer's *read* buffer
    // and neither asks for a swap, so renderTarget2 is what actually holds the scene — and
    // its depth texture is the clone that got written, not the one handed in above.
    // Deliberately not bound to a fixed target here — see `_syncDepthTexture`.
    this.tiltShift.enabled = this.settings.get('tiltShift')
    this.tiltShift.setStrength(this.settings.get('tiltShiftStrength'))
    this.tiltShift.setAngle(this.settings.get('tiltShiftAngle'))
    this.tiltShift.setCamera(this.camera)
    this.tiltShift.setFocusDistance(this._focusDistance)

    // OutputPass is what applies tone mapping + sRGB once, at the end of the chain.
    composer.addPass(new OutputPass())

    this.smaaPass = new SMAAPass(1, 1)
    composer.addPass(this.smaaPass)

    this.composer = composer
  }

  _disposeComposer() {
    if (!this.composer) return
    this.composer.renderTarget1?.dispose()
    this.composer.renderTarget2?.dispose()
    for (const pass of this.composer.passes) pass.dispose?.()
    this.composer = null
    this.bloomPass = null
    this.smaaPass = null
    this.tiltShift = null
  }

  resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = Math.max(1, parent.clientWidth)
    const h = Math.max(1, parent.clientHeight)

    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()

    const scale = this._targetScale()
    const bw = Math.max(1, Math.round(w * scale))
    const bh = Math.max(1, Math.round(h * scale))

    // Only the drawing buffer is sized here. The element's own size is left to the CSS
    // (`position: absolute; inset: 0`), because a hand-written width is a second opinion
    // about how big the canvas is — and the moment the two disagree, the scene is drawn to
    // one rectangle while every panel is positioned against the other.
    this.renderer.setSize(bw, bh, false)
    this.composer?.setSize(bw, bh)
    this.tiltShift?.setSize(bw, bh)
    this.tiltShift?.setCamera(this.camera)
    this.viewport = { w, h, bw, bh, scale }
  }

  /**
   * Buffer pixels per CSS pixel. `renderScale` is a share of what the display can actually
   * show, so 100% is native on any panel and 50% is half of it either way.
   */
  /**
   * Point the depth-of-field pass at the depth that was actually just written.
   *
   * This cannot be wired once at build time. `EffectComposer` keeps its read/write buffers
   * between frames, and this chain performs an odd number of swaps, so the two targets trade
   * places every frame — and `RenderPass` always draws into whichever is currently the *read*
   * buffer. Binding one target's depth texture permanently therefore samples the previous
   * frame's depth on every other frame, which shows up as the whole picture strobing between
   * sharp and smeared rather than as anything recognisable as a depth-of-field bug.
   */
  _syncDepthTexture() {
    if (this.tiltShift && this.composer) {
      this.tiltShift.setDepthTexture(this.composer.readBuffer.depthTexture)
    }
  }

  /** What the view is looking at, so the plane of focus can sit on it. */
  setFocusDistance(distance) {
    this._focusDistance = distance
    this.tiltShift?.setFocusDistance(distance)
  }

  _targetScale() {
    return this.settings.get('renderScale') * (window.devicePixelRatio || 1)
  }

  start() {
    if (this.running) return
    this.running = true
    this.timer.reset()
    // Opening the colony counts as somebody being here, and the first frame has no previous
    // one to be an interval away from.
    this.gate.noteActivity(nowMs())
    this._lastFrameAt = null
    this.renderer.setAnimationLoop(this._boundLoop)
  }

  stop() {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  _loop() {
    const started = nowMs()
    // Everything below is skipped on a frame the gate turns down — no timer update, no
    // updaters, no draw. The simulation is not stepped in slow motion, it is simply stepped
    // less often with a correspondingly larger dt, so the colony keeps real time at every
    // rate and a capped frame costs exactly nothing.
    if (!this.gate.shouldRender(started)) return

    this.timer.update()
    // The timer already zeroes the delta across a hidden tab; the clamp is the backstop for
    // an ordinary long frame, so one stalled frame never jumps the whole colony forward.
    //
    // It is 0.2s rather than 0.1s because the idle rate is a deliberate 6 fps at its slowest
    // — a 167ms step that is *real elapsed time*, not a stall — and clamping it would run the
    // colony slow whenever nobody was looking, which is the one place a drift would quietly
    // accumulate for hours. Sub-stepping would keep the old clamp, but at the cost of doing
    // the update work twice on exactly the frames the pacing exists to make cheap.
    const dt = Math.min(this.timer.getDelta(), MAX_STEP)
    this.elapsed += dt

    for (const u of this.updaters) u.update?.(dt, this.elapsed)

    this.renderer.info.reset()
    if (this.composer && (this.settings.get('bloom') || this.settings.get('antialias') || this.settings.get('tiltShift'))) {
      this._syncDepthTexture()
      this.composer.render(dt)
    } else {
      this.renderer.render(this.scene, this.camera)
    }

    // Two different numbers, and conflating them is what breaks a capped loop: the interval
    // between frames is the cap once there is one, and says nothing about the machine. What
    // the governor needs is how long the work took. (CPU time around the draw call, since
    // WebGL has no cheap GPU clock — but a GPU that is behind blocks the submit, so a real
    // overload still lands in this number.)
    const interval = started - (this._lastFrameAt ?? started)
    this._lastFrameAt = started
    this.perf.sample(nowMs() - started, interval, this.renderer.info)
    if (this.settings.get('autoQuality')) this._governQuality()
  }

  /**
   * Draw one frame without stepping the simulation. Used by the screenshot path, which has
   * to read the drawing buffer in the same task as the draw that filled it — the alternative
   * is `preserveDrawingBuffer`, which costs a full copy on every frame forever.
   */
  renderFrame() {
    this.renderer.info.reset()
    if (this.composer && (this.settings.get('bloom') || this.settings.get('antialias') || this.settings.get('tiltShift'))) {
      this._syncDepthTexture()
      this.composer.render(0)
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Adaptive render scale. Never touches the setting the user chose; it scales *under* it.
   *
   * Every move resizes the drawing buffer and rebuilds the post chain's render targets,
   * which is a visible event — on WebKit it can cost a black frame outright. So the bar for
   * moving is deliberately high: a full second between samples, several consecutive samples
   * agreeing before anything changes, and a long cooldown before it climbs back after a
   * drop. A governor that reacts to one bad second finds the boundary and then sits on it,
   * resizing back and forth for as long as you leave the window open.
   */
  _governQuality() {
    const now = performance.now()
    if (now - (this._lastGovern || 0) < 1000) return
    this._lastGovern = now
    // Nothing to govern for an empty room. Every move here resizes the drawing buffer, and
    // doing that to a window nobody is looking at is churn with no audience.
    if (this.gate.isIdle(now)) return

    // The *work* per frame, not the interval between frames. Under a 30 fps cap every
    // interval is ~33ms, which the old reading took for a struggling machine — and the
    // governor would then drop render scale on the fastest laptop made, forever, because
    // the evidence it was reading was its own cap. 22ms and 17ms are the same bar as the
    // 45 fps / 58 fps it used to compare against, just measured on the half that is about
    // the machine.
    const cost = this.perf.frameMs
    if (cost <= 0) return
    const ceiling = this._targetScale()
    const current = this.viewport?.scale ?? ceiling
    // The floor is half the display's own resolution, not half a CSS pixel: on a retina
    // panel the old absolute 0.5 was a quarter-resolution buffer, which reads as broken
    // rather than as a machine having a hard time.
    const floor = 0.35 * (window.devicePixelRatio || 1)

    // Sustained evidence, not one sample: 3 slow seconds to drop, 8 fast ones to climb.
    this._slow = cost > 22 ? (this._slow || 0) + 1 : 0
    this._fast = cost < 17 ? (this._fast || 0) + 1 : 0
    const dpr = window.devicePixelRatio || 1

    let next = current
    if (this._slow >= 3) {
      next = Math.max(floor, current - 0.15 * dpr)
      this._slow = 0
      // Having just proved this machine cannot hold the higher scale, do not go back and
      // ask it again ten seconds later — that is the oscillation.
      this._climbAt = now + 30000
    } else if (this._fast >= 8 && current < ceiling && now >= (this._climbAt || 0)) {
      next = Math.min(ceiling, current + 0.1 * dpr)
      this._fast = 0
    }

    if (Math.abs(next - current) > 0.01) {
      const parent = this.canvas.parentElement
      if (!parent) return
      const bw = Math.max(1, Math.round(parent.clientWidth * next))
      const bh = Math.max(1, Math.round(parent.clientHeight * next))
      this.renderer.setSize(bw, bh, false)
      this.composer?.setSize(bw, bh)
      this.tiltShift?.setSize(bw, bh)
    this.tiltShift?.setCamera(this.camera)
      this.viewport = { ...this.viewport, bw, bh, scale: next }
      this.autoScaled = next < ceiling - 0.01
    }
  }

  dispose() {
    this.stop()
    this.timer.dispose()
    this._unsubscribe?.()
    window.removeEventListener('resize', this._onResize)
    this._dprQuery?.removeEventListener?.('change', this._onResize)
    this._observer?.disconnect()
    document.removeEventListener('visibilitychange', this._onWake)
    window.removeEventListener('focus', this._onWake)
    window.removeEventListener('pageshow', this._onWake)
    if (this._onFocus) {
      window.removeEventListener('focus', this._onFocus)
      window.removeEventListener('blur', this._onBlur)
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, this._onActivity)
    }
    this._disposeComposer()
    this.renderer.dispose()
  }
}

/**
 * Rolling frame stats — an EMA so the readout does not flicker on a single slow frame.
 *
 * Two clocks, because under a frame cap they are no longer the same one:
 * `frameMs` is what a frame *cost* (the governor's evidence about the machine) and `fps` is
 * how often frames are actually reaching the screen (what the readout promises). Capped to
 * 30, a healthy machine reads "30 fps · 6 ms", which is the honest description of both.
 */
class PerfMonitor {
  constructor() {
    this.fps = 0
    this.frameMs = 0
    this.intervalMs = 0
    this.drawCalls = 0
    this.triangles = 0
    this._frames = 0
  }

  sample(workMs, intervalMs, info) {
    const k = this._frames < 10 ? 0.3 : 0.06
    this.frameMs += (workMs - this.frameMs) * k
    if (intervalMs > 0) {
      this.intervalMs += (intervalMs - this.intervalMs) * k
      this.fps = this.intervalMs > 0 ? 1000 / this.intervalMs : 0
    }
    this._frames++
    if (this._frames % 10 === 0) {
      this.drawCalls = info.render.calls
      this.triangles = info.render.triangles
    }
  }
}
