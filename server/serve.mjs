import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acceptedEncoding, apiMiddleware } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Formats that arrive compressed already. Running them through brotli spends CPU to grow the
 * file by a few bytes, so they always go out as-is — `Vary` and the rest are unchanged.
 */
const PACKED = new Set(['.png', '.ico', '.woff2'])

/**
 * Below this, the encoding is a loss: gzip's own framing is ~20 bytes, brotli's is smaller but
 * still real, and a 300-byte file costs a round of CPU on both ends to save nothing worth having.
 */
const MIN_COMPRESS = 1024

/**
 * Brotli's default is quality 11, which takes the better part of a second on a 900KB bundle. At
 * 6–8 it is within a percent or two of that on text and an order of magnitude faster — and since
 * every body is compressed once and then cached, this is paid once per file per process.
 */
const BROTLI_QUALITY = 7

/**
 * path + encoding + mtime → the exact bytes that go on the wire.
 *
 * `dist/` is immutable for the life of a process (it is built before the server starts) and the
 * whole of it is ~5MB, so holding the encoded bodies costs less memory than one model and saves
 * both the read and the compression on every request after the first.
 *
 * mtime is in the key because the *assumption* above is the part that breaks: `npm run build`
 * over a running server rewrites dist in place, and a key on the path alone would then serve the
 * previous build's JS until someone restarted the process — the kind of bug you chase for an hour.
 */
const bodies = new Map()

/** Resolve inside dist/ only — a request can never climb out with `..`. */
function resolveInDist(dist, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(dist, rel || 'index.html')
  return file === dist || file.startsWith(dist + path.sep) ? file : null
}

function compress(raw, encoding) {
  if (encoding === 'br') {
    // The size hint lets brotli pick its window up front instead of growing into one.
    return zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
  }
  return zlib.gzipSync(raw)
}

/**
 * The bytes for one file under one encoding, computed once. Returns the encoding actually used:
 * a body that failed to shrink (already-packed formats, incompressible noise) goes out as
 * identity rather than making the client pay to decode something larger than the original.
 */
async function bodyFor(file, mtimeMs, wanted) {
  // Encoding and mtime first: they are fixed-shape tokens, so no two distinct triples can
  // collide however odd a filename inside dist is.
  const key = `${wanted}:${mtimeMs}:${file}`
  const hit = bodies.get(key)
  if (hit) return hit

  const raw = await fsp.readFile(file)
  let entry = { body: raw, encoding: 'identity' }
  if (wanted !== 'identity' && raw.length >= MIN_COMPRESS && !PACKED.has(path.extname(file))) {
    const packed = compress(raw, wanted)
    if (packed.length < raw.length) entry = { body: packed, encoding: wanted }
  }
  bodies.set(key, entry)
  return entry
}

/**
 * The built app plus a tiny JSON API, over one socket.
 *
 * Returned unlistened so tests can bind an ephemeral port against a throwaway `dist`; the entry
 * point at the bottom is the only thing that listens.
 */
export function createServer({
  dist = DIST,
  host = process.env.BOT_CROSSING_HOST || '127.0.0.1',
  port = Number(process.env.PORT) || 5274,
} = {}) {
  const root = path.resolve(dist)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) {
      return apiMiddleware(req, res, null)
    }

    let file = resolveInDist(root, url.pathname)
    if (!file) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(root, 'index.html') // SPA fallback
    }

    try {
      // stat before read: on a cache hit the mtime is all we need, and the file is never opened.
      const { mtimeMs } = await fsp.stat(file)
      const wanted = acceptedEncoding(req.headers['accept-encoding'])
      const { body, encoding } = await bodyFor(file, mtimeMs, wanted)
      const type = TYPES[path.extname(file)] || 'application/octet-stream'
      const cache = file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
      const headers = {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': cache,
        // On every static response, identity included: a shared cache that stored an identity
        // body without this would go on handing it to clients that asked for br, and one that
        // stored a br body would hand it to a client that cannot read it.
        Vary: 'Accept-Encoding',
      }
      if (encoding !== 'identity') headers['Content-Encoding'] = encoding
      res.writeHead(200, headers)
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    }
  })

  // The resolved address travels with the server so a caller taking the defaults does not have
  // to re-derive them from the environment.
  server.listenOn = { host, port, dist: root }
  return server
}

// Only the process that was *started* on this file listens; importing it (tests, embedding)
// must not open a socket.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  const server = createServer()
  const { host, port } = server.listenOn
  server.listen(port, host, () => {
    console.log(`Bot Crossing → http://${host}:${port}`)
  })
}
