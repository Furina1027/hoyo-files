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
import { fileURLToPath } from 'node:url'

import { assembleUsmFromChunks, detectUsmBytes, detectUsmFormat, downloadPredownloadFiles, gameStatus, predownloadChunkInfo, predownloadDir, predownloadSummary, refreshGame, updateUsmHistory, usmBytesToMkv, usmBytesToMp4, usmToMp4 } from './refresh.mjs'

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
function fetchLocalUsm(game, file, log = () => {}, customRoot = null) {
  const root = customRoot || GAME_DIRS[game]
  const dirs = GAME_VIDEO_DIRS[game]
  if (!root || !dirs) return null
  const base = path.basename(file)
  if (!base.toLowerCase().endsWith('.usm')) return null
  for (const sub of dirs) {
    const p = path.join(root, sub, base)
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p)
        log(`[usm] 使用本地游戏文件: ${p} (${buf.length} 字节)`)
        return new Uint8Array(buf)
      }
    } catch { /* 忽略 */ }
  }
  // 绝区零等分层的目录: 基名直查未命中时做受限递归搜索
  for (const sub of dirs) {
    const rootDir = path.join(root, sub)
    try {
      if (!fs.existsSync(rootDir)) continue
      const stack = [rootDir]
      while (stack.length) {
        const cur = stack.pop()
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const cp = path.join(cur, e.name)
          if (e.isDirectory()) {
            if (stack.length < 32) stack.push(cp)
          } else if (e.name === base) {
            const buf = fs.readFileSync(cp)
            log(`[usm] 使用本地游戏文件(递归): ${cp} (${buf.length} 字节)`)
            return new Uint8Array(buf)
          }
        }
      }
    } catch { /* 忽略 */ }
  }
  return null
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}

const server = http.createServer(async (req, res) => {
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

  // ---- API: USM 格式探测 (直链失败自动回退 chunk 组装; 避开浏览器外网/大响应限制) ----
  if (url.pathname === '/api/usm-detect' && req.method === 'GET') {
    const target = url.searchParams.get('url') ?? ''
    const game = url.searchParams.get('game') ?? ''
    const file = url.searchParams.get('file') ?? ''
    const version = url.searchParams.get('version') ?? ''
    const gameDir = url.searchParams.get('game_dir') ?? null
    try {
      let format = null
      const localUsm = fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm) {
        format = await detectUsmBytes(localUsm, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
      }
      if (!format && target) {
        try {
          format = await detectUsmFormat(target, { game, file, dataDir: DATA_ROOT, log: msg => tlog(msg) })
        }
        catch (err) {
          console.log(`[usm-detect] 直链失败, 回退 chunk: ${err.message}`)
        }
      }
      if (!format && game && file) {
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
    const file = url.searchParams.get('file') ?? ''
    const version = url.searchParams.get('version') ?? ''
    const gameDir = url.searchParams.get('game_dir') ?? null
    let target = url.searchParams.get('url') ?? ''
    // 支持按 游戏+文件+版本 拼直链 (兼容旧调用)
    if (!target && version) {
      try {
        const versions = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, `${game}_versions.json`), 'utf-8'))
        const vd = versions[version]
        const base = vd?.decompressed_path
        if (base)
          target = `${base.replace(/\/+$/, '')}/${file}`
      }
      catch { /* 保持空 */ }
    }
    try {
      let mp4 = null
      const localUsm = fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
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
      res.end(Buffer.from(mp4), () => tlog('[api] usm-mp4 响应已发送', ((Date.now()-t0)/1000).toFixed(2)+'s'))
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
    const file = url.searchParams.get('file') ?? ''
    const version = url.searchParams.get('version') ?? ''
    const chIndex = Number(url.searchParams.get('ch') ?? '0') || 0
    const gameDir = url.searchParams.get('game_dir') ?? null
    let target = url.searchParams.get('url') ?? ''
    if (!target && version) {
      try {
        const versions = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, `${game}_versions.json`), 'utf-8'))
        const base = versions[version]?.decompressed_path
        if (base)
          target = `${base.replace(/\/+$/, '')}/${file}`
      }
      catch { /* 保持空 */ }
    }
    try {
      let mkv = null
      const localUsm = fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
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
      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
        'Content-Length': mkv.length,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      })
      res.end(Buffer.from(mkv), () => tlog('[api] usm-mkv 响应已发送', ((Date.now()-t0)/1000).toFixed(2)+'s'))
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
    const file = url.searchParams.get('file') ?? ''
    const version = url.searchParams.get('version') ?? ''
    const target = url.searchParams.get('url') ?? ''
    const gameDir = url.searchParams.get('game_dir') ?? null
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
    try {
      // 本地游戏文件优先（Persistent 副本的 nonce/audioKey 与 CDN 基线不同）
      const localUsm = fetchLocalUsm(game, file, msg => tlog(msg), gameDir)
      if (localUsm) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': localUsm.length,
          'Cache-Control': 'no-cache',
        })
        res.end(Buffer.from(localUsm))
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
          const reader = upstream.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done)
              break
            res.write(Buffer.from(value))
          }
          res.end()
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
    const gameId = decodeURIComponent(refreshMatch[1])
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
    const gameId = decodeURIComponent(usmRefreshMatch[1])
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
    const gameId = decodeURIComponent(ciMatch[1])
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
    const data = predownloadSummary(decodeURIComponent(sumMatch[1]), DATA_ROOT)
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data ?? { error: 'no predownload data' }))
    return
  }

  // ---- API: 预下载目录浏览 (按需加载, 每次响应都很小) ----
  const dirMatch = url.pathname.match(/^\/api\/predownload\/([^/]+)$/)
  if (dirMatch && req.method === 'GET') {
    const gameId = decodeURIComponent(dirMatch[1])
    const data = predownloadDir(gameId, DATA_ROOT, url.searchParams.get('tag') ?? '', url.searchParams.get('dir') ?? '', url.searchParams.get('q') ?? '')
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data ?? { error: 'no data' }))
    return
  }

  // ---- API: 预下载文件下载 (NDJSON 流式: 每完成一个文件推一行进度, 最后一行是结果) ----
  const dlMatch = url.pathname.match(/^\/api\/predownload-download\/([^/]+)$/)
  if (dlMatch && req.method === 'POST') {
    const gameId = decodeURIComponent(dlMatch[1])
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
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '')
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
    // JSON 响应启用 gzip (浏览器 fetch 自动解压, 大清单体积可减 7 倍)
    if (ext === '.json' && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
      const gz = zlib.gzipSync(fs.readFileSync(filePath))
      res.writeHead(200, {
        'Content-Type': MIME[ext],
        'Content-Length': gz.length,
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-cache',
      })
      res.end(gz)
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(filePath).pipe(res)
  })
})

// 仅监听回环: 该服务可经 game_dir 参数读取本机游戏文件, 不应对局域网暴露
const HOST = argValue('--host', '127.0.0.1')
server.listen(PORT, HOST, () => {
  console.log(`hoyo-files 数据服务器已启动: http://${HOST}:${PORT}`)
  console.log(`数据目录: ${DATA_ROOT}`)
  console.log('前端请设置 VITE_API_BASE=http://localhost:' + PORT)
})
