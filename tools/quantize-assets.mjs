/**
 * Shrinks the built glbs in `public/assets` with `KHR_mesh_quantization`.
 *
 * The packs ship every vertex attribute as float32. Normals, UVs, colours and skin
 * weights do not need that range — a byte or a short says the same thing to within a
 * pixel — so they are quantized here and the glb declares the extension that tells a
 * loader how to read them back. three.js has supported it since r111.
 *
 * `build-kit.mjs` and `build-crew.mjs` apply the same transform as part of a rebuild from
 * `assets-src/`, and import the pattern and the two checks below so the two cannot drift.
 * This script exists for the checked-in glbs, which are what a fresh clone actually loads:
 * it rewrites them in place and is safe to re-run, because quantizing already-quantized
 * attributes lands on the same values.
 *
 * Usage: quantize-assets.mjs [file.glb ...]
 * With no arguments, every glb in `public/assets` is processed.
 */
import { NodeIO } from '@gltf-transform/core'
import { KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, prune, quantize, resample } from '@gltf-transform/functions'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The attributes worth quantizing — which is every one the colony uses except POSITION.
 *
 * POSITION has to stay float32. `src/world/buildings.js` scales, rotates and translates
 * cloned kit geometry in place, and `src/agents/crew.js` reads vertices out with
 * getComponent into Float32Arrays; both work on the raw attribute array and neither
 * applies the normalization an int16 POSITION would need, so quantizing it would silently
 * shrink every building to a fraction of its size and scatter the crew's geometry. The
 * saving is not worth the trap — the bulk of the win is in NORMAL and TEXCOORD anyway.
 */
export const QUANTIZE_ATTRIBUTES = /^(NORMAL|TANGENT|TEXCOORD_\d+|JOINTS_\d+|WEIGHTS_\d+|COLOR_\d+)$/

const ASSETS = 'public/assets'
const DEFAULTS = ['crew.glb', 'forest.glb', 'spacebase.glb'].map((f) => `${ASSETS}/${f}`)

/** An IO that knows the extension, so the written glb declares it instead of dropping it. */
export const quantizingIO = () => new NodeIO().registerExtensions([KHRMeshQuantization])

const FLOAT = 5126
const UNSIGNED_BYTE = 5121
const UNSIGNED_SHORT = 5123

/**
 * Whether a primitive holds an attribute plain glTF 2.0 has no way to describe.
 *
 * The base spec pins NORMAL and TANGENT to float and allows TEXCOORD only as float or
 * unsigned-normalized, so the int16 normals below need the extension declared or a strict
 * loader is within its rights to reject the file. The rest of what we quantize — JOINTS as
 * u8, WEIGHTS and TEXCOORD as unsigned-normalized — is legal unaided and does not count.
 *
 * Morph targets are walked too: quantize() defaults `patternTargets` to `pattern`, so a
 * model with morphed normals would quantize them along with the base mesh's.
 */
const needsQuantization = (prim) => prim.listSemantics().some((semantic) => {
  const attribute = prim.getAttribute(semantic)
  const small = attribute.getComponentSize() < 4
  if (semantic === 'POSITION' || semantic === 'NORMAL' || semantic === 'TANGENT') return small
  if (!semantic.startsWith('TEXCOORD_')) return false
  const type = attribute.getComponentType()
  const unsignedNorm = attribute.getNormalized() && (type === UNSIGNED_BYTE || type === UNSIGNED_SHORT)
  return small && !unsignedNorm
}) || (prim.listTargets?.() ?? []).some(needsQuantization)

/**
 * Declares `KHR_mesh_quantization` on a quantized document, and returns whether it did.
 *
 * quantize() is meant to do this itself, but @gltf-transform/functions 4.4.2 decides with
 * `isQuantizedAttribute(semantic, prim.getAttribute('POSITION'))` — it tests POSITION's
 * component size under every semantic's name, so a document that deliberately keeps
 * POSITION float is judged unquantized and writes a glb that does not admit to its own
 * int16 normals. Called after the transforms rather than inside them so that prune() has
 * no chance to drop an extension nothing points at.
 */
export function declareQuantization(doc) {
  const prims = doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
  if (!prims.some(needsQuantization)) return false
  doc.createExtension(KHRMeshQuantization).setRequired(true) // idempotent: reuses an existing one
  return true
}

/**
 * Throws if anything quantized POSITION. Not an assertion about the pattern above so much
 * as the thing that stops a future widening of it writing a silently broken glb over the
 * good one — the runtime reads POSITION raw, so the damage would show up as geometry, not
 * as an error.
 */
export function assertFloatPositions(doc, label) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION')
      if (position && position.getComponentType() !== FLOAT) {
        throw new Error(`${label}: POSITION was quantized — see QUANTIZE_ATTRIBUTES for why it must not be`)
      }
    }
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

async function shrink(path) {
  if (!existsSync(path)) throw new Error(`quantize-assets: no such file: ${path}`)
  const before = statSync(path).size

  const io = quantizingIO()
  const doc = await io.read(path)

  // resample() collapses constant animation tracks — only the crew has any, and it is
  // harmless on the two that have not. dedup() and prune() clear up the accessors
  // quantize leaves behind.
  await doc.transform(
    resample(),
    quantize({ pattern: QUANTIZE_ATTRIBUTES }),
    dedup(),
    prune()
  )

  assertFloatPositions(doc, basename(path))
  declareQuantization(doc)

  await io.write(path, doc)
  const after = statSync(path).size
  const delta = before ? ((after - before) / before) * 100 : 0
  console.log(`  ${basename(path).padEnd(14)} ${kb(before).padStart(10)} → ${kb(after).padStart(10)}  ${delta.toFixed(1)}%`)
  return [before, after]
}

async function main(files) {
  console.log(`quantize-assets: ${files.length} file${files.length === 1 ? '' : 's'}`)
  let before = 0
  let after = 0
  for (const file of files) {
    const [was, is] = await shrink(file)
    before += was
    after += is
  }
  const delta = before ? ((after - before) / before) * 100 : 0
  console.log(`  ${'total'.padEnd(14)} ${kb(before).padStart(10)} → ${kb(after).padStart(10)}  ${delta.toFixed(1)}%`)
}

// Only when run directly — build-kit and build-crew import from here and do their own writing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2)
  await main(files.length ? files : DEFAULTS)
}
