/**
 * The static server: what it refuses, what it falls back to, and what it compresses.
 *
 * The compression half is the reason this file exists. A built colony is a ~890KB bundle and
 * ~2MB of models, and over a LAN the difference between sending that raw and sending it gzipped
 * is the difference between a colony that loads and one you wait for — but a content-negotiating
 * server is also exactly the kind of thing that silently starts lying about `Content-Encoding`,
 * so every assertion here is made against the raw bytes on the wire.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

// api.mjs reads BOT_CROSSING_DATA once, at import — so the env goes in first and the import is
// dynamic and cache-busted, the same dance test/state.test.mjs does. serve.mjs pulls api.mjs in.
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-serve-data-'))
process.env.BOT_CROSSING_DATA = DATA
const { createServer } = await import(`../server/serve.mjs?${DATA}`)

after(() => fsp.rm(DATA, { recursive: true, force: true }))

const INDEX = '<!doctype html><title>Bot Crossing</title><div id="app"></div>'

// ~70KB that looks like a real chunk of built JS: repetitive, and so very compressible.
const BIG = Array.from(
  { length: 1200 },
  (_, i) => `export const plot${i} = { x: ${i}, y: ${i % 7}, label: 'astronaut', zone: 'colony' }`
).join('\n')

const TINY = 'export const v = 1 // under a kilobyte, not worth a single byte of gzip framing\n'

/** A throwaway dist/ with the three shapes that matter: a page, a big asset, a tiny one. */
async function makeDist() {
  const dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-dist-'))
  await fsp.mkdir(path.join(dist, 'assets'))
  await fsp.writeFile(path.join(dist, 'index.html'), INDEX)
  await fsp.writeFile(path.join(dist, 'assets', 'big.js'), BIG)
  await fsp.writeFile(path.join(dist, 'assets', 'tiny.js'), TINY)
  // Named .png but full of text: only the extension can stop this being compressed.
  await fsp.writeFile(path.join(dist, 'assets', 'flat.png'), 'p'.repeat(4096))
  return dist
}

/**
 * Node's built-in fetch decompresses transparently and strips `Content-Encoding` on the way
 * through, which would leave every assertion below unable to tell gzip from identity. So these
 * go over node:http and keep the bytes exactly as they arrived.
 */
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
  })
}

async function withServe(run) {
  const dist = await makeDist()
  const server = createServer({ dist })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    await run({ port, dist, get: (p, h) => get(port, p, h) })
  } finally {
    server.close()
    await fsp.rm(dist, { recursive: true, force: true })
  }
}

// ── content negotiation ───────────────────────────────────────────────────────

test('a client that asks for nothing gets the file untouched — but is told the answer varies', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/big.js')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.headers.vary, 'Accept-Encoding')
    assert.equal(res.body.toString(), BIG)
    assert.equal(Number(res.headers['content-length']), res.body.length)
  })
})

test('Accept-Encoding: gzip gets gzip, and it gunzips to the original bytes', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/big.js', { 'Accept-Encoding': 'gzip' })
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(res.headers.vary, 'Accept-Encoding')
    assert.equal(gunzipSync(res.body).toString(), BIG)
    // Content-Length must describe what was actually sent, not the file on disk.
    assert.equal(Number(res.headers['content-length']), res.body.length)
    const raw = Buffer.byteLength(BIG)
    assert.ok(res.body.length < raw / 4, `70KB of JS should collapse, got ${res.body.length} of ${raw}`)
  })
})

test('br wins when both are on offer', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/big.js', { 'Accept-Encoding': 'br, gzip' })
    assert.equal(res.headers['content-encoding'], 'br')
    assert.equal(brotliDecompressSync(res.body).toString(), BIG)
    assert.equal(Number(res.headers['content-length']), res.body.length)
  })
})

test('a client that refuses gzip outright is not handed gzip', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/big.js', { 'Accept-Encoding': 'gzip;q=0' })
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.body.toString(), BIG)
  })
})

test('a file under a kilobyte is never compressed', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/tiny.js', { 'Accept-Encoding': 'br, gzip' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.headers.vary, 'Accept-Encoding', 'still varies — the same URL can answer in br')
    assert.equal(res.body.toString(), TINY)
  })
})

test('an already-compressed format is left alone however compressible it looks', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/assets/flat.png', { 'Accept-Encoding': 'br, gzip' })
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.body.length, 4096)
  })
})

// ── the cache ─────────────────────────────────────────────────────────────────

test('the second request for an asset is served from memory, and only mtime can dislodge it', async () => {
  await withServe(async ({ get, dist }) => {
    const file = path.join(dist, 'assets', 'big.js')
    // Pinned to a whole millisecond first: a natural mtime carries sub-millisecond precision
    // that a Date cannot put back, and this test needs to restore the key exactly.
    const at = new Date(1_700_000_000_000)
    await fsp.utimes(file, at, at)

    const first = await get('/assets/big.js', { 'Accept-Encoding': 'gzip' })
    const second = await get('/assets/big.js', { 'Accept-Encoding': 'gzip' })
    assert.deepEqual(second.body, first.body, 'identical bytes, not re-compressed to something new')

    // Rewrite the file but put its timestamp back: the cache key has not moved, so the bytes
    // must not either. This is the cheap proof that nothing re-read or re-compressed the file.
    await fsp.writeFile(file, `${BIG}\n// a whole new build`)
    await fsp.utimes(file, at, at)
    const stale = await get('/assets/big.js', { 'Accept-Encoding': 'gzip' })
    assert.deepEqual(stale.body, first.body, 'same mtime, same cached body')

    // And the other half of the key: a real rebuild moves mtime, and the new bytes go out.
    await fsp.utimes(file, at, new Date(at.getTime() + 2000))
    const rebuilt = await get('/assets/big.js', { 'Accept-Encoding': 'gzip' })
    assert.match(gunzipSync(rebuilt.body).toString(), /a whole new build$/)
  })
})

// ── paths, fallbacks, caching headers ─────────────────────────────────────────

test('a path that tries to climb out of dist is refused, not served', async () => {
  await withServe(async ({ get }) => {
    // `/../package.json` is flattened to `/package.json` by URL parsing before it ever reaches
    // the guard; the encoded slash is the form that actually survives to try the escape.
    assert.equal((await get('/..%2fpackage.json')).status, 403)
    assert.equal((await get('/assets%2f..%2f..%2fpackage.json')).status, 403)
  })
})

test('an unknown path falls back to index.html, because the colony routes in the browser', async () => {
  await withServe(async ({ get }) => {
    const res = await get('/colony/some-thread')
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), INDEX)
    assert.match(res.headers['content-type'], /text\/html/)
  })
})

test('a directory serves its index.html', async () => {
  await withServe(async ({ get }) => {
    assert.equal((await get('/')).body.toString(), INDEX)
  })
})

test('hashed assets are immutable and the page never is', async () => {
  await withServe(async ({ get }) => {
    const asset = await get('/assets/big.js')
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')
    const page = await get('/index.html')
    assert.equal(page.headers['cache-control'], 'no-cache')
  })
})

// ── the API shares the negotiation ────────────────────────────────────────────

test('a large /api/state answers gzip, and it decodes to the colony', async () => {
  await withServe(async ({ get, port }) => {
    // The empty state is a couple of hundred bytes; only a real colony crosses the threshold.
    const archived = Array.from({ length: 80 }, (_, i) => `claude-code:session-${i}-padding-padding`)
    const colony = JSON.stringify({ version: 2, archived, updatedAt: 1 })
    await fsp.writeFile(path.join(DATA, 'colony.json'), colony)

    const res = await get('/api/state', {
      'Accept-Encoding': 'gzip',
      Origin: `http://localhost:${port}`,
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(res.headers['cache-control'], 'no-store')
    const state = JSON.parse(gunzipSync(res.body).toString())
    assert.equal(state.version, 2)
    assert.equal(state.archived.length, 80)
  })
})

test('a small API answer is sent as-is — compressing it would only add bytes', async () => {
  await withServe(async ({ get, port }) => {
    const res = await get('/api/nothing-here', {
      'Accept-Encoding': 'gzip',
      Origin: `http://localhost:${port}`,
    })
    assert.equal(res.status, 404)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.deepEqual(JSON.parse(res.body.toString()), { error: 'Unknown endpoint' })
  })
})
