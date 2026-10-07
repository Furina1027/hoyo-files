/**
 * hoyo-files 本地数据服务器 (零依赖 Node)
 *
 * 静态托管 pkg_version 数据仓库, 供前端 (VITE_API_BASE) 使用:
 *   GET /{game}_versions.json
 *   GET /chunk/{game}_{version}.json
 *   GET /{game}/{version}/pkg_version
 *   GET /predownload/{game}.json
 *
 * 用法: node server/server.mjs [--port 8787] [--data ../pkg_version]
 * 数据仓库默认位于本仓库根目录: <hoyo-files>/pkg_version
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { assembleUsmFromChunks, detectUsmBytes, detectUsmFormat, downloadPredownloadFiles, gameStatus, predownloadChunkInfo, predownloadDir, predownloadSummary, readJsonCached, refreshGame, updateUsmHistory, usmBytesToMkv, usmBytesToMp4, usmBytesToWebm, usmToMp4 } from './refresh.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
}

const PORT = Number(argValue('--port', process.env.PORT || 8787))
const DATA_ROOT = path.resolve(__dirname, argValue('--data', '../pkg_version'))

// ---- 本地游戏文件回退（USM 视频）----
// 游戏实际播放的可能是 Persistent 热更副本（如崩铁 Act3060/3070，其 VIDEO_HDRINFO
// nonce 与 CDN/StreamingAssets 基线版不同，密钥只对热更副本有效），因此 USM 一律
// 优先读本地游戏文件：Persistent → StreamingAssets → （否则走 CDN/chunk）。
// 目录表按游戏配置；游戏安装位置可用环境变量 HSR_GAME_DIR / HK4E_GAME_DIR / NAP_GAME_DIR 覆盖。
const GAME_DIRS = {
  hkrpg: process.env.HSR_GAME_DIR || 'E:/miHoYo Launcher/games/Star Rail Game',
  hk4e: process.env.HK4E_GAME_DIR || 'E:/Genshin Impact bilibili/games/Genshin Impact Game',
  nap: process.env.NAP_GAME_DIR || 'E:/miHoYo Launcher/games/ZenlessZoneZero Game',
}
const GAME_VIDEO_DIRS = {
  hkrpg: ['StarRail_Data/Persistent/Video/Windows', 'StarRail_Data/StreamingAssets/Video/Windows'],
  hk4e: ['YuanShen_Data/Persistent/VideoAssets/StandaloneWindows64', 'YuanShen_Data/StreamingAssets/VideoAssets/StandaloneWindows64'],
  nap: ['ZenlessZoneZero_Data/Persistent/Video/HD', 'ZenlessZoneZero_Data/StreamingAssets/Video/HD'],
}
const GAME_NAMES = {
  hkrpg: '崩坏：星穹铁道',
  hk4e: '原神',
  nap: '绝区零',
}

// 67_test 在 7.1 已无法正常播放，但资源结构与历史 67 相同。
// 前端继续显示/请求原文件名；后端静默改取历史 67，前端不暴露这个替换。
const USM_BACKEND_ALIASES = {
  hk4e: {
    'video_reunion_67_test.usm': {
      file: 'Video_Reunion_67.usm',
      version: '6.7.0',
      fallbackFile: 'YuanShen_Data/StreamingAssets/VideoAssets/StandaloneWindows64/Video_Reunion_67.usm',
    },
  },
}

function resolveUsmBackendRequest(game, file, version = '') {
  const original = String(file ?? '')
  const normalized = original.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const alias = USM_BACKEND_ALIASES[game]?.[base]
  if (!alias)
    return { file: original, version, aliased: false }

  const marker = '/StandaloneWindows64/'
  const markerIndex = normalized.lastIndexOf(marker)
  let aliasedFile
  if (markerIndex !== -1)
    aliasedFile = `${normalized.slice(0, markerIndex + marker.length)}${alias.file}`
  else if (normalized.includes('/'))
    aliasedFile = `${normalized.slice(0, normalized.lastIndexOf('/') + 1)}${alias.file}`
  else
    aliasedFile = alias.fallbackFile

  return { file: aliasedFile, version: alias.version || version, aliased: true }
}

/**
 * 从请求的 file 里剥出「相对视频根」的路径，用于同根内精确命中。
 * 例: ZenlessZoneZero_Data/StreamingAssets/Video/HD/Yorozuya/Skyscraper/X.usm + 视频根
 *     ZenlessZoneZero_Data/StreamingAssets/Video/HD  →  Yorozuya/Skyscraper/X.usm
 * 识别不出已知视频根时返回 null（此时完全退回旧的按文件名查找行为）。
 */
function relWithinVideoRoots(file, dirs) {
  const norm = String(file).replace(/\\/g, '/').replace(/^\/+/, '')
  for (const sub of dirs) {
    const s = String(sub).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!s) continue
    if (norm === s) return ''
    if (norm.startsWith(`${s}/`)) return norm.slice(s.length + 1)
    const idx = norm.indexOf(`/${s}/`)
    if (idx !== -1) return norm.slice(idx + s.length + 2)
  }
  return null
}

/**
 * 本地游戏目录的 USM 文件索引缓存: rootDir -> { at, byName, byLower }。
 * 递归兜底（绝区零等分层目录）改为先建一次索引，避免「每个文件都遍历整棵树」。
 * 用短 TTL 而非永久缓存，游戏热更/删除文件后最多 30 秒自行失效。
 */
const LOCAL_DIR_INDEX_TTL = 30_000
const localDirIndexCache = new Map()

function localDirIndex(rootDir) {
  const now = Date.now()
  const hit = localDirIndexCache.get(rootDir)
  if (hit && now - hit.at < LOCAL_DIR_INDEX_TTL)
    return hit

  const byName = new Map()
  const byLower = new Map()
  const stack = [rootDir]
  let scanned = 0
  while (stack.length && scanned < 200_000) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    }
    catch { continue }
    for (const e of entries) {
      scanned++
      const cp = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(cp)
      }
      else if (e.name.toLowerCase().endsWith('.usm')) {
        const nameHits = byName.get(e.name)
        if (nameHits)
          nameHits.push(cp)
        else
          byName.set(e.name, [cp])

        const low = e.name.toLowerCase()
        const lowHits = byLower.get(low)
        if (lowHits)
          lowHits.push(cp)
        else
          byLower.set(low, [cp])
      }
    }
  }

  const entry = { at: now, byName, byLower }
  localDirIndexCache.set(rootDir, entry)
  return entry
}

/** 视频根属于哪一类（用于日志与前端展示本地来源） */
function localRootKind(sub) {
  return String(sub).includes('Persistent') ? 'Persistent' : 'StreamingAssets'
}

async function pathExists(p) {
  try {
    await fs.promises.stat(p)
    return true
  }
  catch {
    return false
  }
}

/**
 * 有限并发地跑 fn(items[i], i)，保持结果顺序。
 * /api/usm-local-files 一次几百个路径的探测用，避免 Promise.all 全量并发
 * 打爆磁盘，也避免纯串行把事件循环外的等待时间拉长。
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 定位本地游戏里的 USM 文件 —— 只探测存在性，不读字节
 * （批量探测数百个文件时，读盘代价不可接受）。
 *
 * 顺序与取字节时完全一致：视频根按目录表顺序（Persistent 热更 → StreamingAssets），
 * 根内先按请求路径精确命中（同名文件很多，只认文件名会拿错那一份），
 * 再按文件名直查，最后递归兜底（路径尾部一致的那一份优先）。
 *
 * 返回 { path, root, kind, how } 或 null。
 */
async function locateLocalUsm(game, file, customRoot = null) {
  const root = customRoot || GAME_DIRS[game]
  const dirs = GAME_VIDEO_DIRS[game]
  if (!root || !dirs)
    return null
  const norm = String(file).replace(/\\/g, '/')
  const base = path.basename(norm)
  if (!base.toLowerCase().endsWith('.usm'))
    return null
  const rel = relWithinVideoRoots(norm, dirs)
  const relLow = rel ? rel.toLowerCase() : null
  const hit = (p, sub, how) => ({ path: p, root: sub, kind: localRootKind(sub), how })

  // 1) 按请求里的目录精确命中
  if (rel) {
    for (const sub of dirs) {
      const p = path.join(root, sub, rel)
      if (await pathExists(p))
        return hit(p, sub, '')
    }
  }
  // 2) 根内按文件名直查
  for (const sub of dirs) {
    const p = path.join(root, sub, base)
    if (await pathExists(p))
      return hit(p, sub, '')
  }
  // 3) 递归兜底（分层目录）
  for (const sub of dirs) {
    const rootDir = path.join(root, sub)
    if (!(await pathExists(rootDir)))
      continue
    const { byName, byLower } = localDirIndex(rootDir)
    const hits = byName.get(base) ?? byLower.get(base.toLowerCase()) ?? []
    if (!hits.length)
      continue
    if (relLow) {
      const exact = hits.find(p => p.replace(/\\/g, '/').toLowerCase().endsWith(`/${relLow}`))
      if (exact)
        return hit(exact, sub, '(递归/精确路径)')
    }
    return hit(hits[0], sub, '(递归)')
  }
  return null
}

/**
 * 本地 USM 完整字节缓存: 播放/导出一次会话里同一文件会被 usm-detect →
 * usm-webm/usm-mp4 → usm-proxy(音频提取) 依次完整读取，几百 MB 的文件
 * 每次都 readFileSync 既慢又阻塞。键含 mtime/size，游戏热更替换文件后自动失效。
 * 只放最近 2 个文件且总量受限；缓存条目被调用方只读（解密/解析均先拷贝），共享安全。
 */
const LOCAL_USM_CACHE_MAX_ENTRIES = 2
const LOCAL_USM_CACHE_MAX_BYTES = 1.5 * 1024 * 1024 * 1024
const localUsmCache = new Map() // key -> Uint8Array

function localUsmCacheKey(p, stat) {
  return `${p}|${stat.mtimeMs}|${stat.size}`
}

function localUsmCacheGet(key) {
  const hit = localUsmCache.get(key)
  if (!hit)
    return null
  // LRU 触碰: 删除再插入，保持 Map 迭代顺序 = 最旧在前
  localUsmCache.delete(key)
  localUsmCache.set(key, hit)
  return hit
}

function localUsmCachePut(key, bytes) {
  localUsmCache.set(key, bytes)
  let total = 0
  for (const v of localUsmCache.values())
    total += v.length
  while (localUsmCache.size > LOCAL_USM_CACHE_MAX_ENTRIES
    || (total > LOCAL_USM_CACHE_MAX_BYTES && localUsmCache.size > 1)) {
    const oldest = localUsmCache.keys().next().value
    const evicted = localUsmCache.get(oldest)
    localUsmCache.delete(oldest)
    total -= evicted.length
  }
}

async function fetchLocalUsm(game, file, log = () => {}, customRoot = null) {
  const found = await locateLocalUsm(game, file, customRoot)
  if (!found)
    return null
  let stat
  try {
    stat = await fs.promises.stat(found.path)
  }
  catch {
    return null
  }
  const key = localUsmCacheKey(found.path, stat)
  let bytes = localUsmCacheGet(key)
  if (bytes) {
    log(`[usm] 使用本地游戏文件${found.how} (${found.kind}, 缓存命中): ${found.path} (${bytes.length} 字节)`)
    return bytes
  }
  let buf
  try {
    buf = await fs.promises.readFile(found.path)
  }
  catch (err) {
    log(`[usm] 本地文件读取失败: ${found.path}: ${err.message}`)
    return null
  }
  bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  localUsmCachePut(key, bytes)
  log(`[usm] 使用本地游戏文件${found.how} (${found.kind}): ${found.path} (${bytes.length} 字节)`)
  return bytes
}

/**
 * 只读本地 USM 的前 maxBytes 字节, 供"探测视频格式"用。
 *
 * detectUsmBytes 只需要第一个视频块的 magic (4 字节) 和 VIDEO_HDRINFO 里的
 * AES-CTR nonce, 两者都在文件头部; 而完整文件动辄 300MB+。头部不足时
 * detectUsmBytes 会返回 null, 调用方需回退到 fetchLocalUsm 完整读取,
 * 因此这里不做任何判定逻辑, 只是少读。
 */
async function fetchLocalUsmHead(game, file, log = () => {}, customRoot = null, maxBytes = 8 << 20) {
  const found = await locateLocalUsm(game, file, customRoot)
  if (!found)
    return null
  let stat
  try {
    stat = await fs.promises.stat(found.path)
  }
  catch {
    return null
  }
  const len = Math.min(maxBytes, stat.size)
  if (len <= 0)
    return new Uint8Array(0)

  // 完整文件已在缓存里（例如刚被 usm-webm 转换过）: 直接切片, 不再碰盘
  const cached = localUsmCacheGet(localUsmCacheKey(found.path, stat))
  if (cached)
    return cached.subarray(0, len)

  const buf = Buffer.allocUnsafe(len)
  const fd = await fs.promises.open(found.path, 'r')
  try {
    await fd.read(buf, 0, len, 0)
  }
  finally {
    await fd.close()
  }
  log(`[usm] 探测: 读取头部 ${len} 字节 (文件共 ${stat.size} 字节) ${found.path}`)
  return new Uint8Array(buf.buffer, buf.byteOffset, len)
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** JSON gzip 结果缓存: filePath -> { mtimeMs, size, gz } (文件 mtime 变化自动失效) */
const gzipCache = new Map()

/**
 * 宽松解码 URL 路径段。
 *
 * WHATWG URL 解析器不对 pathname 做百分号解码/校验, 落单的 '%' 或截断的
 * UTF-8 (如 '/%'、'/%zz'、'/%e0%a4') 会原样留在 pathname 里; 随后调
 * decodeURIComponent 就会抛 URIError。在 async request handler 里那等于
 * unhandledRejection —— Node 15+ 默认 --unhandled-rejections=throw, 进程直接
 * 结束, 而本服务是 start.cmd 后台拉起的, 崩了不会自愈。
 *
 * 非法转义返回 null, 由调用方回 400。
 */
function safeDecode(seg) {
  try {
    return decodeURIComponent(seg)
  }
  catch {
    return null
  }
}

/** 统一的非法路径段响应, 避免每个分支重复三行 */
function sendBadRequest(res) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Bad Request')
}

async function handleRequest(req, res) {
  // 本地开发: 允许跨域 (vite dev server 不同端口)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)
  const t0 = Date.now()
  const tlog = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)
  if (url.pathname.startsWith('/api/'))
    tlog(`[api] ${req.method} ${url.pathname}${url.searchParams.get('file') ? ' file=' + url.searchParams.get('file').split('/').pop() : ''}`)

  // 读取请求体
  function readBody(request) {
    return new Promise((resolve) => {
      let data = ''
      request.on('data', chunk => data += chunk)
      request.on('end', () => resolve(data))
    })
  }

  // ---- API: 批量探测本地游戏文件 (CDN 已下架时, 前端据此判断还能否播放/导出) ----
  // 只回「在不在 + 在哪」，不读字节：一次请求几百个路径也只做存在性检查。
  if (url.pathname === '/api/usm-local-files' && req.method === 'POST') {
    let body = {}
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    }
    catch { /* 非法 body 视为空 */ }
    const game = body.game ?? ''
    const gameDir = body.game_dir ?? null
    const files = Array.isArray(body.files) ? body.files : []
    try {
      const found = {}
      const results = await mapPool(files.filter(f => typeof f === 'string' && f), 16, async (f) => {
        const request = resolveUsmBackendRequest(game, f, '')
        let hit = await locateLocalUsm(game, request.file, gameDir)
        if (!hit && request.aliased)
          hit = await locateLocalUsm(game, f, gameDir)
        if (!hit)
          return null
        let size = null
        try {
          size = (await fs.promises.stat(hit.path)).size
        }
        catch { /* 忽略 */ }
        return [f, { path: hit.path, source: hit.kind, how: hit.how, size }]
      })
      for (const r of results) {
        if (r)
          found[r[0]] = r[1]
      }
      tlog(`[usm-local] ${game}: 命中本地 ${Object.keys(found).length}/${files.length}`)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ game, game_dir: gameDir ?? GAME_DIRS[game] ?? null, found }))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: USM 格式探测 (直链失败自动回退 chunk 组装; 避开浏览器外网/大响应限制) ----
  if (url.pathname === '/api/usm-detect' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? ''
    const request = resolveUsmBackendRequest(game, url.searchParams.get('file') ?? '', url.searchParams.get('version') ?? '')
    const file = request.file
    const version = request.version
    const target = request.aliased ? '' : url.searchParams.get('url') ?? ''
    const gameDir = url.searchParams.get('game_dir') ?? null
    try {
      let format = null
      const localUsmHead = await fetchLocalUsmHead(game, file, msg => tlog(msg), gameDir)
      if (localUsmHead) {
        format = await detectUsmBytes(localUsmHead, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        if (!format) {
          // 头部不足以判定 (第一个视频块比 maxBytes 更靠后): 回退完整读取,
          // 行为与改动前完全一致。
          const localUsm = await fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
          if (localUsm)
            format = await detectUsmBytes(localUsm, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        }
      }
      if (!format && target) {
        try {
          format = await detectUsmFormat(target, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        }
        catch (err) {
          console.log(`[usm-detect] 直链失败, 回退 chunk: ${err.message}`)
        }
      }
      // 无版本号时不做 chunk 回退：assembleUsmFromChunks 会退到「最新版本」，
      // 而最新版本的清单必然不含已下架文件，白付一次 chunk 索引构建的代价。
      // 本地文件已在上面命中，这里只处理「浏览器直链挂了但知道目标版本」的情况。
      if (!format && version && game && file) {
        const usm = await assembleUsmFromChunks(game, file, { version, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        format = await detectUsmBytes(usm, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ format }))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: USM → MP4 输出 (浏览器 <video> 直接加载; 直链失败自动回退 chunk 组装) ----
  if (url.pathname === '/api/usm-mp4' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? ''
    const request = resolveUsmBackendRequest(game, url.searchParams.get('file') ?? '', url.searchParams.get('version') ?? '')
    const file = request.file
    const version = request.version
    const gameDir = url.searchParams.get('game_dir') ?? null
    let target = request.aliased ? '' : url.searchParams.get('url') ?? ''
    // 支持按 游戏+文件+版本 拼直链 (兼容旧调用)
    if (!target && version) {
      const versions = readJsonCached(path.join(DATA_ROOT, `${game}_versions.json`))
      const base = versions?.[version]?.decompressed_path
      if (base)
        target = `${base.replace(/\/+$/, '')}/${file}`
    }
    try {
      let mp4 = null
      const localUsm = await fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm) {
        mp4 = await usmBytesToMp4(localUsm, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
      }
      if (!mp4 && target) {
        try {
          mp4 = await usmToMp4(target, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        }
        catch (err) {
          console.log(`[usm-mp4] 直链失败, 回退 chunk: ${err.message}`)
        }
      }
      if (!mp4) {
        const usm = await assembleUsmFromChunks(game, file, { version, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        mp4 = await usmBytesToMp4(usm, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': mp4.length,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      })
      res.end(mp4, () => tlog('[api] usm-mp4 响应已发送', ((Date.now()-t0)/1000).toFixed(2)+'s'))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`USM 转换失败: ${err.message}`)
    }
    return
  }

  // ---- API: USM → MKV 输出 (H.264 视频 + ADX 音频, 崩铁导出用; 直链失败自动回退 chunk 组装) ----
  if (url.pathname === '/api/usm-mkv' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? ''
    const request = resolveUsmBackendRequest(game, url.searchParams.get('file') ?? '', url.searchParams.get('version') ?? '')
    const file = request.file
    const version = request.version
    const rawCh = url.searchParams.get('ch')
    const parsedCh = rawCh == null || rawCh === '' ? null : Number(rawCh)
    const chIndex = Number.isInteger(parsedCh) && parsedCh >= 0 ? parsedCh : null
    const gameDir = url.searchParams.get('game_dir') ?? null
    let target = request.aliased ? '' : url.searchParams.get('url') ?? ''
    if (!target && version) {
      const versions = readJsonCached(path.join(DATA_ROOT, `${game}_versions.json`))
      const base = versions?.[version]?.decompressed_path
      if (base)
        target = `${base.replace(/\/+$/, '')}/${file}`
    }
    try {
      // usmBytesToMkv 返回分段数组 (EBML 头/Segment/各 Cluster), 拼接动作交给
      // res.write 逐段发出, 省掉两份全量拷贝。
      let mkv = null
      const localUsm = await fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm) {
        mkv = await usmBytesToMkv(localUsm, { game, file, dataDir: DATA_ROOT, chIndex, log: msg => tlog(msg) })
      }
      if (!mkv && target) {
        try {
          const res0 = await fetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
            signal: AbortSignal.timeout(300_000),
          })
          if (res0.ok) {
            mkv = await usmBytesToMkv(new Uint8Array(await res0.arrayBuffer()), { game, file, dataDir: DATA_ROOT, chIndex, log: msg => tlog(msg) })
          }
          else {
            console.log(`[usm-mkv] 直链失败 HTTP ${res0.status}, 回退 chunk`)
          }
        }
        catch (err) {
          console.log(`[usm-mkv] 直链失败, 回退 chunk: ${err.message}`)
        }
      }
      if (!mkv) {
        const usm = await assembleUsmFromChunks(game, file, { version, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        mkv = await usmBytesToMkv(usm, { game, file, dataDir: DATA_ROOT, chIndex, log: msg => tlog(msg) })
      }
      const total = mkv.reduce((s, p) => s + p.length, 0)
      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
        'Content-Length': total,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      })
      for (const part of mkv)
        res.write(part)
      res.end(() => tlog('[api] usm-mkv 响应已发送', ((Date.now()-t0)/1000).toFixed(2)+'s'))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`USM 转换失败: ${err.message}`)
    }
    return
  }

  if (url.pathname === '/api/usm-webm' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? ''
    const request = resolveUsmBackendRequest(game, url.searchParams.get('file') ?? '', url.searchParams.get('version') ?? '')
    const file = request.file
    const version = request.version
    const rawCh = url.searchParams.get('ch')
    const parsedCh = rawCh == null || rawCh === '' ? null : Number(rawCh)
    const chIndex = Number.isInteger(parsedCh) && parsedCh >= 0 ? parsedCh : null
    const includeAudio = url.searchParams.get('audio') !== '0'
    const gameDir = url.searchParams.get('game_dir') ?? null
    let target = request.aliased ? '' : url.searchParams.get('url') ?? ''
    if (!target && version) {
      const versions = readJsonCached(path.join(DATA_ROOT, `${game}_versions.json`))
      const base = versions?.[version]?.decompressed_path
      if (base)
        target = `${base.replace(/\/+$/, '')}/${file}`
    }
    try {
      let webm = null
      const localUsm = await fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm)
        webm = await usmBytesToWebm(localUsm, { game, file, dataDir: DATA_ROOT, chIndex, includeAudio, log: msg => tlog(msg) })
      if (!webm && target) {
        try {
          const res0 = await fetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
            signal: AbortSignal.timeout(300_000),
          })
          if (res0.ok)
            webm = await usmBytesToWebm(new Uint8Array(await res0.arrayBuffer()), { game, file, dataDir: DATA_ROOT, chIndex, includeAudio, log: msg => tlog(msg) })
        }
        catch (err) {
          console.log(`[usm-webm] 直链失败, 回退 chunk: ${err.message}`)
        }
      }
      if (!webm) {
        const usm = await assembleUsmFromChunks(game, file, { version, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        webm = await usmBytesToWebm(usm, { game, file, dataDir: DATA_ROOT, chIndex, includeAudio, log: msg => tlog(msg) })
      }
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Content-Length': webm.length,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      })
      res.end(webm, () => tlog('[api] usm-webm 响应已发送', ((Date.now() - t0) / 1000).toFixed(2) + 's'))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`USM 转换失败: ${err.message}`)
    }
    return
  }

  // ---- API: USM 原始文件代理 (VP9 流式解码由浏览器 fetch 全量 USM; 直链失败自动回退 chunk 组装) ----
  if (url.pathname === '/api/usm-proxy' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? ''
    const request = resolveUsmBackendRequest(game, url.searchParams.get('file') ?? '', url.searchParams.get('version') ?? '')
    const file = request.file
    const version = request.version
    const target = request.aliased ? '' : url.searchParams.get('url') ?? ''
    const gameDir = url.searchParams.get('game_dir') ?? null
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
    try {
      // 本地游戏文件优先（Persistent 副本的 nonce/audioKey 与 CDN 基线不同）
      const localUsm = await fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': localUsm.length,
          'Cache-Control': 'no-cache',
        })
        res.end(localUsm)
        return
      }
      if (target) {
        const upstream = await fetch(target, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(300_000),
        })
        if (upstream.ok) {
          const len = upstream.headers.get('content-length') ?? ''
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            ...(len ? { 'Content-Length': len } : {}),
            'Cache-Control': 'no-cache',
          })
          // pipe 自带背压处理; 手写 read 循环会无视 res.write 的缓冲水位
          Readable.fromWeb(upstream.body).pipe(res)
          return
        }
        console.log(`[usm-proxy] 直链失败 HTTP ${upstream.status}, 回退 chunk`)
      }
      const usm = await assembleUsmFromChunks(game, file, { version, dataDir: DATA_ROOT, log: msg => tlog(msg) })
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': usm.length,
        'Cache-Control': 'no-cache',
      })
      res.end(usm)
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`USM 获取失败: ${err.message}`)
    }
    return
  }

  // ---- API: 原生文件夹选择对话框 (Windows 本地开发用) ----
  if (url.pathname === '/api/browse-dir' && req.method === 'POST') {
    if (process.platform !== 'win32') {
      res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '文件夹选择对话框仅支持 Windows' }))
      return
    }
    let body = {}
    try {
      body = JSON.parse(await readBody(req))
    }
    catch { /* 空 body */ }
    // 只取已知游戏 id 对应的中文名, 客户端字符串绝不拼进 PowerShell 脚本
    const label = GAME_NAMES[body.gameId] ?? '游戏'
    // 用 PowerShell 调出系统原生文件夹选择对话框; windowsHide 避免闪窗
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = '选择${label}游戏根目录 (含 *_Data 文件夹的那一层)'
      $dialog.ShowNewFolderButton = $true
      $dialog.UseDescriptionForTitle = $true
      if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }
    `
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true })
      const result = await new Promise((resolve) => {
        let out = ''
        let settled = false
        const finish = (v) => {
          if (!settled) {
            settled = true
            resolve(v)
          }
        }
        child.stdout.on('data', d => out += d.toString())
        child.on('error', () => finish(null))
        child.on('exit', code => finish(code === 0 && out.trim() ? out.trim() : null))
        // 客户端断开(关页面/请求超时)时结束对话框进程, 避免残留
        res.on('close', () => {
          if (!settled) {
            try { child.kill() }
            catch { /* 忽略 */ }
            finish(null)
          }
        })
      })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ path: result }))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: 游戏数据状态 ----
  if (url.pathname === '/api/games' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(gameStatus(DATA_ROOT)))
    return
  }

  // ---- API: 刷新指定游戏数据 ----
  const refreshMatch = url.pathname.match(/^\/api\/refresh\/([^/]+)$/)
  if (refreshMatch && req.method === 'POST') {
    const gameId = safeDecode(refreshMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    try {
      const result = await refreshGame(gameId, DATA_ROOT, msg => console.log(msg))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: 更新 USM 文件历史 (对比当前版本 vs 上一个版本的 pkg_version 清单) ----
  const usmRefreshMatch = url.pathname.match(/^\/api\/refresh-usm-history\/([^/]+)$/)
  if (usmRefreshMatch && req.method === 'POST') {
    const gameId = safeDecode(usmRefreshMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    try {
      const result = updateUsmHistory(gameId, DATA_ROOT, msg => tlog(msg))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: 预下载单文件 chunk 直下信息 (浏览器端下载) ----
  const ciMatch = url.pathname.match(/^\/api\/predownload-chunkinfo\/([^/]+)$/)
  if (ciMatch && req.method === 'GET') {
    const gameId = safeDecode(ciMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    const file = url.searchParams.get('file') ?? ''
    try {
      const data = await predownloadChunkInfo(gameId, DATA_ROOT, file, msg => console.log(msg))
      res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data ?? { error: 'file not found in chunk build' }))
    }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ---- API: 预下载汇总 (小响应, 含各 tag 统计) ----
  const sumMatch = url.pathname.match(/^\/api\/predownload-summary\/([^/]+)$/)
  if (sumMatch && req.method === 'GET') {
    const gameId = safeDecode(sumMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    const data = predownloadSummary(gameId, DATA_ROOT)
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data ?? { error: 'no predownload data' }))
    return
  }

  // ---- API: 预下载目录浏览 (按需加载, 每次响应都很小) ----
  const dirMatch = url.pathname.match(/^\/api\/predownload\/([^/]+)$/)
  if (dirMatch && req.method === 'GET') {
    const gameId = safeDecode(dirMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    const data = predownloadDir(gameId, DATA_ROOT, url.searchParams.get('tag') ?? '', url.searchParams.get('dir') ?? '', url.searchParams.get('q') ?? '')
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data ?? { error: 'no data' }))
    return
  }

  // ---- API: 预下载文件下载 (NDJSON 流式: 每完成一个文件推一行进度, 最后一行是结果) ----
  const dlMatch = url.pathname.match(/^\/api\/predownload-download\/([^/]+)$/)
  if (dlMatch && req.method === 'POST') {
    const gameId = safeDecode(dlMatch[1])
    if (gameId === null) {
      sendBadRequest(res)
      return
    }
    let body = {}
    try {
      body = JSON.parse(await readBody(req))
    }
    catch { /* 空 body */ }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    try {
      const result = await downloadPredownloadFiles(gameId, DATA_ROOT, {
        files: body.files ?? null,
        dirs: body.dirs ?? null,
        kinds: body.kinds ?? null,
        gameDir: body.game_dir || null,
        outRoot: body.out_root || null,
        log: msg => tlog(msg),
        signal: abort.signal,
        onProgress: (p) => {
          res.write(`${JSON.stringify({ type: 'progress', ...p })}\n`)
        },
      })
      res.write(`${JSON.stringify({ type: 'done', ...result })}\n`)
      res.end()
    }
    catch (err) {
      if (abort.signal.aborted) {
        if (!res.headersSent) {
          res.writeHead(499, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'cancelled' }))
        }
        else {
          res.write(`${JSON.stringify({ type: 'error', error: 'cancelled' })}\n`)
          res.end()
        }
        return
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message }))
      }
      else {
        res.write(`${JSON.stringify({ type: 'error', error: err.message })}\n`)
        res.end()
      }
    }
    return
  }

  // ---- 静态文件 ----
  // 防目录穿越: 去掉前导分隔符后 normalize, 再解析
  const decodedPath = safeDecode(url.pathname)
  if (decodedPath === null) {
    sendBadRequest(res)
    return
  }
  const rel = path.normalize(decodedPath).replace(/^[\\/]+/, '')
  const filePath = path.resolve(DATA_ROOT, rel)
  if (!filePath.startsWith(DATA_ROOT)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    const ext = path.extname(filePath)
    console.log(`[req] ${req.method} ${url.pathname} (${stat.size} bytes, ae=${req.headers['accept-encoding'] ?? '-'})`)

    // ETag (mtime+size): 前端重复拉取同一份大清单时回 304, 不再全量重传
    const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }

    // Range 请求 (探测/断点): 返回 206 部分内容, 不走 gzip
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m?.[1] ? Number(m[1]) : 0
      let end = m?.[2] ? Number(m[2]) : stat.size - 1
      if (Number.isNaN(start) || start < 0)
        start = 0
      if (Number.isNaN(end) || end >= stat.size)
        end = stat.size - 1
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }
    res.on('finish', () => console.log(`[res] ${url.pathname} sent ${res.writableLength === 0 ? 'done' : '?'}`))
    // JSON 响应启用 gzip (浏览器 fetch 自动解压, 大清单体积可减 7 倍)。
    // 压缩按 mtime 缓存且异步执行: 原来每个请求都 gzipSync 同步压缩几 MB 的
    // 清单, 压缩期间整个事件循环(含正在推流的视频)都被卡住。
    if (ext === '.json' && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
      const gzHit = gzipCache.get(filePath)
      if (gzHit && gzHit.mtimeMs === stat.mtimeMs && gzHit.size === stat.size) {
        res.writeHead(200, {
          'Content-Type': MIME[ext],
          'Content-Length': gzHit.gz.length,
          'Content-Encoding': 'gzip',
          'ETag': etag,
          'Cache-Control': 'no-cache',
        })
        res.end(gzHit.gz)
        return
      }
      fs.readFile(filePath, (readErr, raw) => {
        if (readErr) {
          res.writeHead(500)
          res.end('Read Error')
          return
        }
        zlib.gzip(raw, (gzErr, gz) => {
          if (gzErr || res.destroyed) {
            if (!res.headersSent) {
              res.writeHead(500)
              res.end('Gzip Error')
            }
            return
          }
          gzipCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, gz })
          if (gzipCache.size > 32) {
            gzipCache.delete(gzipCache.keys().next().value)
          }
          res.writeHead(200, {
            'Content-Type': MIME[ext],
            'Content-Length': gz.length,
            'Content-Encoding': 'gzip',
            'ETag': etag,
            'Cache-Control': 'no-cache',
          })
          res.end(gz)
        })
      })
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'ETag': etag,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

// 兜底: handler 内部任何未捕获的 rejection 都不允许结束进程。
// 还没发头就回 500; 已经发头(NDJSON / 视频流)就断开, 让客户端看到错误
// 而不是 ECONNRESET。
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[fatal] 请求处理异常:', err)
    if (res.headersSent)
      res.destroy()
    else
      sendBadRequest(res)
  })
})

// 进程级兜底: 只记日志不退出。单请求的异常由上面的 .catch 处理, 这里防的是
// handler 之外(定时器、流回调、未 await 的 promise)漏网的 rejection ——
// 一次崩溃意味着 8787 长时间不可用, 而本服务没有守护重启。
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

// 仅监听回环: 该服务可经 game_dir 参数读取本机游戏文件, 不应对局域网暴露
const HOST = argValue('--host', '127.0.0.1')
server.listen(PORT, HOST, () => {
  console.log(`hoyo-files 数据服务器已启动: http://${HOST}:${PORT}`)
  console.log(`数据目录: ${DATA_ROOT}`)
  console.log('前端请设置 VITE_API_BASE=http://localhost:' + PORT)
})
