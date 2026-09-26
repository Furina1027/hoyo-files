/**
 * 数据刷新模块: 用启动器/下载器官方接口更新本地数据仓库。
 *
 * 数据来源 (全部为已知公开接口):
 *  1. getGameBranches      启动器接口 -> 每游戏 main/pre_download 的 包ID/密码/tag
 *  2. getBuild / getPatchBuild  下载器接口 -> 构建 manifest 列表
 *  3. manifest 下载 (zstd + protobuf) -> 预下载差异 / 当前版本文件清单
 *
 * 产物:
 *  predownload/{game}.json           预下载差异 (前端「预下载」页)
 *  {game}/{version}/pkg_version      当前版本文件清单 (前端「文件列表」页)
 *  chunk/{game}_{version}.json       当前版本 chunk 快照
 *  {game}_versions.json              版本条目 (含 chunk 凭据)
 */

import { createHash, createDecipheriv } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import protobuf from 'protobufjs'
import { ZSTDDecoder } from 'zstddec'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const GAMES = {
  hk4e: { name: '原神', launcher_id: 'jGHBHlcOq1', game_ids: ['1Z8W5NHUQb'] },
  hkrpg: { name: '崩坏：星穹铁道', launcher_id: 'jGHBHlcOq1', game_ids: ['64kMb5iAWu'] },
  nap: { name: '绝区零', launcher_id: 'jGHBHlcOq1', game_ids: ['x6znKlJ0xK'] },
  bh3: { name: '崩坏3', launcher_id: 'jGHBHlcOq1', game_ids: ['osvnlOc0S8'] },
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
const LAUNCHER_HOSTS = ['https://hyp-api.mihoyo.com', 'https://hyp-api-beta.mihoyo.com']
const API_HOSTS = ['https://downloader-api.mihoyo.com', 'https://downloader-api-beta.mihoyo.com']

// ---------- zstd ----------

let _zstd = null
async function zstd() {
  if (!_zstd) {
    const dec = new ZSTDDecoder()
    await dec.init()
    _zstd = dec
  }
  return _zstd
}

async function zstdDecompress(buf, expectedSize) {
  const dec = await zstd()
  const out = dec.decode(new Uint8Array(buf), expectedSize ?? undefined)
  return Buffer.from(out)
}

// ---------- protobuf (动态 schema, 与 Sophon.proto 一致) ----------

const root = new protobuf.Root()
root.add(new protobuf.Type('Chunk')
  .add(new protobuf.Field('id', 1, 'string'))
  .add(new protobuf.Field('uncompressed_md5', 2, 'string'))
  .add(new protobuf.Field('offset', 3, 'int64'))
  .add(new protobuf.Field('compressed_size', 4, 'int64'))
  .add(new protobuf.Field('uncompressed_size', 5, 'int64'))
  .add(new protobuf.Field('unknown', 6, 'int64'))
  .add(new protobuf.Field('compressed_md5', 7, 'string')))
root.add(new protobuf.Type('File')
  .add(new protobuf.Field('file', 1, 'string'))
  .add(new protobuf.Field('chunks', 2, 'Chunk', 'repeated'))
  .add(new protobuf.Field('is_folder', 3, 'bool'))
  .add(new protobuf.Field('size', 4, 'int64'))
  .add(new protobuf.Field('md5', 5, 'string')))
root.add(new protobuf.Type('ChunkManifest')
  .add(new protobuf.Field('chuncks', 1, 'File', 'repeated'))) // 官方拼写
root.add(new protobuf.Type('Patch')
  .add(new protobuf.Field('id', 1, 'string'))
  .add(new protobuf.Field('tag', 2, 'string'))
  .add(new protobuf.Field('build_id', 3, 'string'))
  .add(new protobuf.Field('patch_file_size', 4, 'int64'))
  .add(new protobuf.Field('patch_file_md5', 5, 'string'))
  .add(new protobuf.Field('patch_offset', 6, 'int64'))
  .add(new protobuf.Field('patch_length', 7, 'int64'))
  .add(new protobuf.Field('original_file_name', 8, 'string'))
  .add(new protobuf.Field('original_file_size', 9, 'int64'))
  .add(new protobuf.Field('original_file_md5', 10, 'string')))
root.add(new protobuf.Type('PatchInfo')
  .add(new protobuf.Field('tag', 1, 'string'))
  .add(new protobuf.Field('patch', 2, 'Patch')))
root.add(new protobuf.Type('PatchFile')
  .add(new protobuf.Field('file', 1, 'string'))
  .add(new protobuf.Field('size', 2, 'int64'))
  .add(new protobuf.Field('md5', 3, 'string'))
  .add(new protobuf.Field('patches', 4, 'PatchInfo', 'repeated')))
root.add(new protobuf.Type('PatchDeleteFile')
  .add(new protobuf.Field('file', 1, 'string'))
  .add(new protobuf.Field('size', 2, 'int64'))
  .add(new protobuf.Field('md5', 3, 'string')))
root.add(new protobuf.Type('PatchDeleteCollection')
  .add(new protobuf.Field('delete_files', 1, 'PatchDeleteFile', 'repeated')))
root.add(new protobuf.Type('PatchDeleteTag')
  .add(new protobuf.Field('tag', 1, 'string'))
  .add(new protobuf.Field('delete_collection', 2, 'PatchDeleteCollection')))
root.add(new protobuf.Type('PatchManifest')
  .add(new protobuf.Field('patches', 1, 'PatchFile', 'repeated'))
  .add(new protobuf.Field('delete_tags', 2, 'PatchDeleteTag', 'repeated'))
  .add(new protobuf.Field('compress_mode', 3, 'int32')))

const DECODE_OPTS = { longs: Number, defaults: true, arrays: true, objects: true }
const ChunkManifestMsg = root.lookupType('ChunkManifest')
const PatchManifestMsg = root.lookupType('PatchManifest')

// ---------- 基础工具 ----------

function md5(buf) {
  return createHash('md5').update(buf).digest('hex')
}

async function fetchBytes(url, { expectedSize, expectedMd5 } = {}, retries = 3) {
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (expectedSize != null && buf.length !== expectedSize)
        throw new Error(`大小不匹配 ${buf.length} != ${expectedSize}`)
      if (expectedMd5 && md5(buf) !== expectedMd5.toLowerCase())
        throw new Error(`MD5 不匹配 ${md5(buf)} != ${expectedMd5}`)
      return buf
    }
    catch (err) {
      lastErr = err
    }
  }
  throw new Error(`下载失败: ${url} -> ${lastErr.message}`)
}

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

function cleanUrl(url) {
  url = (url || '').trim()
  if (url.includes('?')) {
    const [base, query] = url.split('?')
    return base.replaceAll(' ', '%20') + '?' + query
  }
  return url.replaceAll(' ', '%20')
}

function joinUrl(prefix, id, suffix = '') {
  let url = `${cleanUrl(prefix).replace(/\/+$/, '')}/${id}`
  if (suffix)
    url += `?${suffix}`
  return url
}

// ---------- 启动器 / 下载器 API ----------

export async function getBranches(game) {
  const hosts = LAUNCHER_HOSTS
  let lastErr
  for (const host of hosts) {
    try {
      const params = new URLSearchParams()
      for (const gid of game.game_ids)
        params.append('game_ids[]', gid)
      params.append('launcher_id', game.launcher_id)
      const res = await fetch(`${host}/hyp/hyp-connect/api/getGameBranches?${params}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30_000),
      })
      const j = await res.json()
      const branches = j.data?.game_branches ?? []
      if (branches.length)
        return { main: branches[0].main ?? null, pre_download: branches[0].pre_download ?? null }
      lastErr = new Error(`retcode ${j.retcode} ${j.message}`)
    }
    catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('getGameBranches 失败')
}

export async function apiCall(api, creds) {
  let lastErr
  for (const host of API_HOSTS) {
    try {
      let url = `${host}/downloader/sophon_chunk/api/${api}`
      let init = {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30_000),
      }
      if (api === 'getBuild') {
        url += `?${new URLSearchParams(creds)}`
      }
      else {
        init = { ...init, method: 'POST', headers: { ...init.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(creds) }
      }
      const res = await fetch(url, init)
      const j = await res.json()
      if (j.retcode === 0)
        return j
      lastErr = new Error(`retcode ${j.retcode} ${j.message}`)
    }
    catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error(`${api} 失败`)
}

// ---------- manifest 下载与解析 ----------

export async function fetchAndParseManifest(ref, verify = true) {
  const url = joinUrl(ref.manifest_download?.url_prefix, ref.manifest.id, ref.manifest_download?.url_suffix)
  const expectedSize = verify ? Number(ref.manifest.compressed_size) : undefined
  const buf = await fetchBytes(url, { expectedSize })
  // zstd 帧: 有魔数则解压, 否则原样 (极少数未压缩)
  const data = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
    ? await zstdDecompress(buf, Number(ref.manifest.uncompressed_size))
    : buf
  if (verify && ref.manifest.checksum && md5(data) !== ref.manifest.checksum.toLowerCase())
    throw new Error(`manifest ${ref.manifest.id} 校验失败`)
  return data
}

async function fetchAllManifests(buildInfo, concurrency = 8) {
  const manifests = buildInfo.data?.manifests ?? []
  return mapPool(manifests, concurrency, ref => fetchAndParseManifest(ref))
}

// ---------- 预下载差异 ----------

function dedupe(entries) {
  const seen = new Map()
  for (const e of entries)
    seen.set(e.file, e)
  return [...seen.values()]
}

async function buildPredownloadDiff(buildInfo) {
  const parsed = await fetchAllManifests(buildInfo)
  const diffs = new Map() // tag -> { added, modified, deleted }

  for (let idx = 0; idx < parsed.length; idx++) {
    const ref = buildInfo.data.manifests[idx]
    const msg = PatchManifestMsg.decode(parsed[idx])
    const man = PatchManifestMsg.toObject(msg, DECODE_OPTS)
    const diffBase = {
      url_prefix: ref.diff_download?.url_prefix ?? '',
      url_suffix: ref.diff_download?.url_suffix ?? '',
    }
    for (const pf of man.patches ?? []) {
      for (const pi of pf.patches ?? []) {
        const tag = String(pi.tag ?? '')
        const d = diffs.get(tag) ?? { added: [], modified: [], deleted: [] }
        diffs.set(tag, d)
        const p = pi.patch ?? {}
        const entry = {
          file: pf.file,
          size: Number(pf.size ?? 0),
          md5: pf.md5 ?? '',
          original_file: '',
          original_size: 0,
          ...diffBase,
          bundle_id: p.id ?? '',
          bundle_offset: Number(p.patch_offset ?? 0),
          bundle_length: Number(p.patch_length ?? 0),
          bundle_size: Number(p.patch_file_size ?? 0),
          bundle_md5: p.patch_file_md5 ?? '',
        }
        if (!p.original_file_name)
          d.added.push(entry)
        else
          d.modified.push({ ...entry, original_file: p.original_file_name, original_size: Number(p.original_file_size ?? 0) })
      }
    }
    for (const dt of man.delete_tags ?? []) {
      const tag = String(dt.tag ?? '')
      const d = diffs.get(tag) ?? { added: [], modified: [], deleted: [] }
      diffs.set(tag, d)
      for (const df of dt.delete_collection?.delete_files ?? [])
        d.deleted.push({ file: df.file, size: Number(df.size ?? 0), md5: df.md5 ?? '', original_file: '', original_size: 0, ...diffBase })
    }
  }

  const payload = {}
  for (const [tag, d] of diffs) {
    d.added = dedupe(d.added)
    d.modified = dedupe(d.modified)
    d.deleted = dedupe(d.deleted)
    const stats = {
      added: d.added.length,
      modified: d.modified.length,
      deleted: d.deleted.length,
      added_size: d.added.reduce((s, e) => s + e.size, 0),
      modified_size: d.modified.reduce((s, e) => s + e.size, 0),
      deleted_size: d.deleted.reduce((s, e) => s + e.size, 0),
    }
    payload[tag] = { entries: d, stats }
  }
  return payload
}

// ---------- 当前版本文件清单 (chunk 模式) ----------

async function buildFileList(buildInfo, concurrency = 8) {
  const parsed = await fetchAllManifests(buildInfo, concurrency)
  const files = []
  for (const raw of parsed) {
    const msg = ChunkManifestMsg.decode(raw)
    const man = ChunkManifestMsg.toObject(msg, DECODE_OPTS)
    for (const f of man.chuncks ?? []) {
      if (f.is_folder)
        continue
      files.push({ remoteName: f.file, md5: f.md5 ?? '', fileSize: Number(f.size ?? 0) })
    }
  }
  return files
}

// ---------- versions.json ----------

function updateVersionsJson(dataDir, gameId, branch) {
  const p = path.join(dataDir, `${gameId}_versions.json`)
  let data = {}
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    }
    catch { /* 重写 */ }
  }
  const ver = branch.tag
  const entry = data[ver] ?? {
    game: {}, voice: {}, update: {}, decompressed_path: null, chunk: null,
  }
  entry.chunk = {
    branch: branch.branch ?? 'main',
    diff_tags: branch.diff_tags ?? [],
    package_id: branch.package_id,
    password: branch.password,
    tag: ver,
  }
  data[ver] = entry
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
  return ver
}

// ---------- 主流程 ----------

export async function refreshGame(gameId, dataDir, log = () => {}) {
  const game = GAMES[gameId]
  if (!game)
    throw new Error(`未知游戏: ${gameId}`)

  const { main, pre_download: pre } = await getBranches(game)
  log(`[${gameId}] 启动器分支: main=${main?.tag ?? '无'}, pre_download=${pre?.tag ?? '无'}`)

  const result = {
    game: gameId,
    name: game.name,
    main_tag: main?.tag ?? null,
    predownload: null,
    file_list: null,
    versions_updated: false,
  }

  // 1) 预下载差异 (branch 用启动器返回的原值, 不可硬编码 'predownload')
  const preCreds = pre ?? main
  if (preCreds) {
    try {
      const buildInfo = await apiCall('getPatchBuild', {
        branch: preCreds.branch ?? 'main',
        package_id: preCreds.package_id,
        password: preCreds.password,
      })
      const manifests = buildInfo.data?.manifests ?? []
      if (manifests.length) {
        log(`[${gameId}] 预下载 ${buildInfo.data.tag}: ${manifests.length} 个 manifest, 下载解析中...`)
        const diffs = await buildPredownloadDiff(buildInfo)
        const tags = Object.keys(diffs)
        const payload = {
          game: gameId,
          current_version: main?.tag ?? tags.at(-1) ?? '',
          predownload_version: buildInfo.data?.tag ?? '',
          build_id: buildInfo.data?.build_id ?? '',
          generated_at: new Date().toISOString(),
          tags,
          diffs,
        }
        const out = path.join(dataDir, 'predownload', `${gameId}.json`)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, JSON.stringify(payload), 'utf-8')
        const s = tags.length ? diffs[tags.at(-1)].stats : null
        result.predownload = {
          tag: payload.predownload_version,
          manifests: manifests.length,
          tags,
          stats: s,
        }
        log(`[${gameId}] 预下载差异已写入: ${tags.map(t => `${t}: 新${diffs[t].stats.added}/改${diffs[t].stats.modified}/删${diffs[t].stats.deleted}`).join(' ')}`)
      }
      else {
        log(`[${gameId}] 预下载 manifest 为空, 跳过`)
      }
    }
    catch (err) {
      result.predownload = { error: err.message }
      log(`[${gameId}] 预下载刷新失败: ${err.message}`)
    }
  }

  // 2) 当前版本文件清单 (仅本地缺失时)
  if (main?.tag) {
    const listPath = path.join(dataDir, gameId, main.tag, 'pkg_version')
    if (!fs.existsSync(listPath)) {
      try {
        const buildInfo = await apiCall('getBuild', {
          branch: main.branch ?? 'main',
          package_id: main.package_id,
          password: main.password,
        })
        const manifests = buildInfo.data?.manifests ?? []
        if (manifests.length) {
          log(`[${gameId}] 当前版本 ${main.tag} 无本地清单, 从 chunk 构建 (${manifests.length} 个 manifest)...`)
          // chunk 快照
          const chunkDir = path.join(dataDir, 'chunk')
          fs.mkdirSync(chunkDir, { recursive: true })
          fs.writeFileSync(path.join(chunkDir, `${gameId}_${main.tag}.json`), JSON.stringify(buildInfo), 'utf-8')
          // 文件清单
          const files = await buildFileList(buildInfo)
          const listDir = path.join(dataDir, gameId, main.tag)
          fs.mkdirSync(listDir, { recursive: true })
          fs.writeFileSync(path.join(listDir, 'pkg_version'), files.map(f => JSON.stringify(f)).join('\n'), 'utf-8')
          result.file_list = { version: main.tag, files: files.length }
          log(`[${gameId}] 文件清单已生成: ${files.length} 个文件`)
        }
      }
      catch (err) {
        result.file_list = { error: err.message }
        log(`[${gameId}] 文件清单生成失败: ${err.message}`)
      }
    }
    else {
      result.file_list = { version: main.tag, existed: true }
    }

    // 3) versions.json 保持最新凭据
    updateVersionsJson(dataDir, gameId, main)
    result.versions_updated = true
  }

  return result
}

// ---------- USM 文件历史更新 ----------

/** 读取某版本 pkg_version 清单中的 USM 文件: { path: {md5, size} } */
function readUsmFilesFromList(dataDir, gameId, version) {
  const listPath = path.join(dataDir, gameId, version, 'pkg_version')
  if (!fs.existsSync(listPath))
    return null
  const text = fs.readFileSync(listPath, 'utf-8')
  const files = {}
  for (const line of text.split('\n')) {
    if (!line.includes('.usm'))
      continue
    try {
      const obj = JSON.parse(line)
      if (obj.remoteName && obj.remoteName.endsWith('.usm'))
        files[obj.remoteName] = { md5: obj.md5 ?? '', size: obj.fileSize ?? 0 }
    }
    catch { /* 忽略坏行 */ }
  }
  return files
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0)
      return d
  }
  return 0
}

/**
 * 用预下载差异，把「基准版本的 USM 清单」推演成「预下载版本的 USM 清单」。
 *
 * 预下载 payload 只保存相对某个基准版本的 added/modified/deleted，没有完整清单，
 * 因此需要 base(基准版本 pkg_version 清单) + 差异 合成 —— 与下载功能同一套语义。
 * 基准版本优先取 payload.current_version，其次取 tags 中本地有清单的最新者。
 */
function synthPredownloadList(dataDir, gameId, pre, log = () => {}) {
  const tags = [pre.current_version, ...(pre.tags ?? [])].filter(Boolean)
  let baseTag = null
  let base = null
  for (const t of tags) {
    const list = readUsmFilesFromList(dataDir, gameId, t)
    if (list) {
      baseTag = t
      base = list
      break
    }
  }
  if (!base) {
    log(`[${gameId}] 预下载清单推演失败: 基准版本清单都不存在 (${tags.join(', ') || '无'})`)
    return null
  }
  const entries = pre.diffs?.[baseTag]?.entries
  if (!entries) {
    log(`[${gameId}] 预下载清单推演失败: payload 里没有 ${baseTag} 的差异`)
    return null
  }
  const isUsm = p => typeof p === 'string' && p.toLowerCase().endsWith('.usm')
  const files = { ...base }
  let nAdd = 0
  let nMod = 0
  let nDel = 0
  for (const e of entries.added ?? []) {
    if (!isUsm(e.file))
      continue
    if (!files[e.file])
      nAdd++
    files[e.file] = { md5: e.md5 ?? '', size: e.size ?? 0 }
  }
  for (const e of entries.modified ?? []) {
    if (!isUsm(e.file))
      continue
    nMod++
    files[e.file] = { md5: e.md5 ?? '', size: e.size ?? 0 }
  }
  for (const e of entries.deleted ?? []) {
    if (!isUsm(e.file))
      continue
    if (files[e.file]) {
      delete files[e.file]
      nDel++
    }
  }
  log(`[${gameId}] 预下载清单推演 (基准 ${baseTag}): ${Object.keys(base).length} → ${Object.keys(files).length} 个 usm (新增 ${nAdd} · 修改 ${nMod} · 删除 ${nDel})`)
  return { tag: baseTag, files }
}

/**
 * 更新 USM 文件历史: 对比「当前版本 vs 上一个版本」的 pkg_version 清单,
 * 只处理最新一个版本之间的差异 (以前版本不动)。
 *
 * 预下载联动: 若本地有 `predownload/{game}.json` 且其 predownload_version 比最新已发布版本更新,
 * 则「当前版本」取**预下载版本**(清单 = 基准版本清单 + 预下载差异推演), 对比基准 = 最新已发布版本。
 * 依据: 预下载只是临时的, 正式版内容与其一致 ⇒ 新文件应立刻进历史, 不必等正式版发布。
 *
 * 规则 (与 GitHub orilights/pkg_version 的 usm/*_history.json 完全一致):
 *   - 新增 (当前有、上版本无): 新增条目 {filename, state: AVAILABLE, versions:[{当前, AVAILABLE, md5, size}]}
 *   - 删除 (当前无、上版本有): 已有条目追加 {当前, DELETED, md5:null, size:null}, 条目 state → DELETED
 *   - 修改 (两边有但 md5 变): 已有条目追加 {当前, AVAILABLE, md5, size}
 *   - 不变: 不追加
 *
 * @returns { {version, prev, added, deleted, changed, history_path} }
 */
export function updateUsmHistory(gameId, dataDir, log = () => {}) {
  const gameDir = path.join(dataDir, gameId)
  if (!fs.existsSync(gameDir))
    throw new Error(`没有 ${gameId} 的版本目录`)

  // 已发布的版本目录 (按 semver 排序)
  const versions = fs.readdirSync(gameDir).filter(v => {
    const lp = path.join(gameDir, v, 'pkg_version')
    return fs.existsSync(lp) && /^\d+\.\d+\.\d+$/.test(v)
  }).sort(compareVersions)

  // 预下载版本优先：预下载只是临时的，正式版与其内容一致，
  // 所以只要本地有预下载数据、且它比最新已发布版本更新，就把「最新版本」当成预下载版本，
  // 让这些新文件当场进历史（对比基准 = 最新已发布版本）。
  let version = null
  let prev = null
  let cur = null
  let old = null
  const pre = loadPredownloadPayload(gameId, dataDir)
  const latest = versions.at(-1) ?? null
  if (pre?.predownload_version && pre.predownload_version !== latest
    && (!latest || compareVersions(pre.predownload_version, latest) > 0)) {
    const synth = latest ? synthPredownloadList(dataDir, gameId, pre, log) : null
    if (synth) {
      version = pre.predownload_version
      prev = latest
      cur = synth.files
      old = readUsmFilesFromList(dataDir, gameId, prev)
      log(`[${gameId}] USM 历史: 对比 ${prev} → ${version} (预下载版本, 基准清单 ${synth.tag})`)
    }
  }

  if (version == null) {
    if (versions.length < 2)
      throw new Error(`需要至少 2 个版本才能对比 (当前: ${versions.join(', ') || '无'})`)
    version = versions.at(-1)
    prev = versions.at(-2)
    log(`[${gameId}] USM 历史: 对比 ${prev} → ${version}`)
    cur = readUsmFilesFromList(dataDir, gameId, version)
    if (!cur)
      throw new Error(`${version} 的 pkg_version 清单不存在`)
  }
  if (!old)
    throw new Error(`${prev} 的 pkg_version 清单不存在`)

  const historyPath = path.join(dataDir, 'usm', `${gameId}_history.json`)
  let history = {}
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'))
    }
    catch {
      log(`[${gameId}] 历史文件损坏, 重建`)
    }
  }

  const added = []
  const deleted = []
  const changed = []

  /**
   * 追加版本记录到 history 条目 (跳过已存在的版本)
   * @returns 'skipped' | 'added' | 'changed'
   */
  function recordAvailable(path, info) {
    const filename = path.slice(path.lastIndexOf('/') + 1)
    const rec = { version, state: 'AVAILABLE', md5: info.md5, size: info.size }
    if (history[path]) {
      // 检查是否已有该版本记录 (幂等)
      if (history[path].versions.some(v => v.version === version))
        return 'skipped'
      history[path].state = 'AVAILABLE'
      history[path].versions.push(rec)
      return 'changed'
    }
    history[path] = { filename, state: 'AVAILABLE', versions: [rec] }
    return 'added'
  }

  // 1) 新增: 当前有、上版本无
  for (const [path, info] of Object.entries(cur)) {
    if (old[path])
      continue
    const r = recordAvailable(path, info)
    if (r === 'skipped') continue
    if (r === 'added')
      added.push(path.slice(path.lastIndexOf('/') + 1))
    else
      changed.push(path.slice(path.lastIndexOf('/') + 1))
  }

  // 2) 修改: 两边都有但 md5 变
  for (const [path, info] of Object.entries(cur)) {
    if (!old[path] || old[path].md5 === info.md5)
      continue
    const r = recordAvailable(path, info)
    if (r !== 'skipped')
      changed.push(path.slice(path.lastIndexOf('/') + 1))
  }

  // 3) 删除: 上版本有、当前无
  for (const [path, info] of Object.entries(old)) {
    if (cur[path])
      continue
    const filename = path.slice(path.lastIndexOf('/') + 1)
    const rec = { version, state: 'DELETED', md5: null, size: null }
    if (history[path]) {
      // 幂等: 已有该版本删除记录则跳过
      if (!history[path].versions.some(v => v.version === version && v.state === 'DELETED')) {
        history[path].state = 'DELETED'
        history[path].versions.push(rec)
        deleted.push(filename)
      }
    }
    else {
      // 上版本有但 history 无记录 (异常) — 先补上版本记录再标记删除
      history[path] = {
        filename,
        state: 'DELETED',
        versions: [
          { version: prev, state: 'AVAILABLE', md5: info.md5, size: info.size },
          rec,
        ],
      }
      deleted.push(filename)
    }
  }

  fs.mkdirSync(path.dirname(historyPath), { recursive: true })
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8')
  log(`[${gameId}] USM 历史已更新: 新增 ${added.length}, 删除 ${deleted.length}, 修改 ${changed.length} → ${historyPath}`)
  return { version, prev, added: added.length, deleted: deleted.length, changed: changed.length, history_path: historyPath }
}

// ---------- 预下载文件下载 (服务端重建, 按游戏内目录落盘) ----------

function findHpatchz() {  const candidates = [
    process.env.HPATCHZ,
    path.resolve(__dirname, '../../hoyo-sophon/third_party/hpatchz.exe'),
    path.resolve(__dirname, '../third_party/hpatchz.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c))
      return c
  }
  return null
}

async function applyHdiff(oldPath, patchPath, outPath, hpatchz) {
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile(hpatchz, ['-f', oldPath, patchPath, outPath], { timeout: 600_000 }, (err) => {
      if (err)
        reject(new Error(`hpatchz 失败: ${err.message}`))
      else
        resolve()
    })
  })
}

function sliceEntry(entry) {
  const url = joinUrl(entry.url_prefix, entry.bundle_id, entry.url_suffix)
  return fetchBytes(url, { expectedSize: entry.bundle_size || undefined, expectedMd5: entry.bundle_md5 || undefined })
    .then(buf => buf.subarray(entry.bundle_offset, entry.bundle_offset + entry.bundle_length))
}

/**
 * 下载预下载文件并重建内容, 按游戏内目录保存到 outRoot/{game}/<file>。
 * files/dirs 为空时下载全部 added + modified;
 * kinds 可限定类型 ('added' / 'modified' / 'added,modified')。
 * files 与 dirs 同时给出时取并集。
 * modified 文件需要 gameDir (游戏安装目录) 中的原文件。
 */
export async function downloadPredownloadFiles(gameId, dataDir, { files = null, dirs = null, kinds = null, gameDir = null, outRoot = null, log = () => {}, signal = null, onProgress = null } = {}) {
  const payloadPath = path.join(dataDir, 'predownload', `${gameId}.json`)
  if (!fs.existsSync(payloadPath))
    throw new Error(`${gameId} 没有预下载数据`)
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'))

  // 合并所有 tag 的 added/modified (按文件去重, 后出现的覆盖)
  const wanted = new Map()
  for (const tag of payload.tags ?? []) {
    for (const e of payload.diffs[tag]?.entries?.added ?? [])
      wanted.set(e.file, { ...e, kind: 'added' })
    for (const e of payload.diffs[tag]?.entries?.modified ?? [])
      wanted.set(e.file, { ...e, kind: 'modified' })
  }
  const fileSet = files ? new Set(files) : null
  const dirPrefixes = dirs && dirs.length ? dirs.map(d => (d ? `${d}/` : '')) : null
  const kindSet = kinds ? new Set(String(kinds).split(',').map(s => s.trim()).filter(Boolean)) : null
  const hasFileFilter = fileSet || dirPrefixes
  const targets = [...wanted.values()].filter((e) => {
    if (kindSet && !kindSet.has(e.kind))
      return false
    if (fileSet && fileSet.has(e.file))
      return true
    if (dirPrefixes?.some(p => e.file.startsWith(p)))
      return true
    return !hasFileFilter
  })

  const hpatchz = findHpatchz()
  if (!hpatchz)
    throw new Error('未找到 hpatchz (HDiffPatch), 请设置 HPATCHZ 环境变量或放置于 third_party/hpatchz.exe')

  const root = path.resolve(outRoot ?? path.join(dataDir, '..', 'downloads'), gameId)
  const bundleCache = path.join(root, '.bundle_cache')
  fs.mkdirSync(bundleCache, { recursive: true })

  // chunk 直下信息 (目标版本可用时优先; 不可用则为 null)
  let chunkIndex = null
  try {
    chunkIndex = await ensureChunkIndex(gameId, dataDir, payload.predownload_version, log)
  }
  catch (err) {
    log(`chunk 索引不可用, 将使用 diff 方式: ${err.message}`)
  }
  // 下载前缀在同一批目标里是常量, 提到循环外 (原来每个文件都重读+重解析一次快照)
  const chunkUrlPrefix = chunkUrlPrefixOf(gameId, dataDir, payload.predownload_version)

  const ok = []
  const failed = []
  let processed = 0

  const total = targets.length
  for (const entry of targets) {
    if (signal?.aborted)
      throw new Error('下载已取消')
    processed++
    let tmp = null
    try {
      const outPath = path.join(root, entry.file)
      if (fs.existsSync(outPath) && fs.statSync(outPath).size === entry.size) {
        ok.push({ file: entry.file, skipped: true })
        onProgress?.({ processed, total, current: entry.file, kind: entry.kind, status: 'skipped' })
        log(`[${processed}/${total}] 已存在: ${entry.file}`)
        continue
      }
      onProgress?.({ processed, total, current: entry.file, kind: entry.kind, status: 'downloading' })
      log(`[${processed}/${total}] ${entry.kind === 'added' ? '新增' : '修改'}: ${entry.file}`)

      fs.mkdirSync(path.dirname(outPath), { recursive: true })

      // 优先 chunk 直下 (与文件列表页相同, 无需本地客户端文件; 也不必下载 diff 切片)
      const chunkEntry = chunkIndex?.[entry.file]
      if (chunkEntry?.chunks?.length) {
        try {
          const info = {
            file: entry.file,
            size: chunkEntry.size,
            md5: chunkEntry.md5,
            url_prefix: chunkUrlPrefix,
            url_suffix: '',
            chunks: chunkEntry.chunks,
          }
          const size = await downloadChunkFile(info, outPath, log)
          ok.push({ file: entry.file, size, mode: 'chunk' })
          log(`  ✓ chunk 直下 ${size} 字节`)
          continue
        }
        catch (err) {
          log(`  chunk 直下失败, 回退 diff: ${err.message}`)
        }
      }

      // 仅当 chunk 直下不可用/失败时才取 diff 切片
      // (切片需整包下载, 大包在 60s 超时内下不完, 放在最后可避免拖死可直下的文件)
      const slice = await sliceEntry(entry)
      tmp = path.join(bundleCache, `slice_${processed}_${Date.now()}.bin`)

      if (entry.kind === 'added') {
        // 新文件: 尝试 zstd 直解, 否则 hpatchz(空源)
        if (slice.length >= 4 && slice[0] === 0x28 && slice[1] === 0xb5 && slice[2] === 0x2f && slice[3] === 0xfd) {
          const data = await zstdDecompress(slice, entry.size)
          if (md5(data) === entry.md5) {
            fs.writeFileSync(outPath, data)
            ok.push({ file: entry.file, size: data.length })
            log(`  ✓ zstd 直解 ${data.length} 字节`)
            continue
          }
        }
        const empty = path.join(bundleCache, `empty_${processed}.bin`)
        fs.writeFileSync(empty, Buffer.alloc(0))
        fs.writeFileSync(tmp, slice)
        await applyHdiff(empty, tmp, outPath, hpatchz)
        const data = fs.readFileSync(outPath)
        if (md5(data) !== entry.md5)
          throw new Error(`输出 MD5 不匹配: ${md5(data)} != ${entry.md5}`)
        ok.push({ file: entry.file, size: data.length })
        log(`  ✓ hpatchz 重建 ${data.length} 字节`)
      }
      else {
        // 修改文件: 需要游戏目录中的原文件
        if (!gameDir)
          throw new Error('修改文件需要游戏安装目录 (game_dir)')
        const original = path.join(gameDir, entry.original_file)
        if (!fs.existsSync(original))
          throw new Error(`原文件不存在: ${entry.original_file}`)
        if (entry.original_size && fs.statSync(original).size !== entry.original_size)
          throw new Error(`原文件大小不匹配: ${entry.original_file}`)
        fs.writeFileSync(tmp, slice)
        await applyHdiff(original, tmp, outPath, hpatchz)
        const data = fs.readFileSync(outPath)
        if (md5(data) !== entry.md5)
          throw new Error(`输出 MD5 不匹配: ${md5(data)} != ${entry.md5}`)
        ok.push({ file: entry.file, size: data.length })
        log(`  ✓ 增量补丁应用 ${data.length} 字节`)
      }
    }
    catch (err) {
      failed.push({ file: entry.file, error: err.message })
      onProgress?.({ processed, total, current: entry.file, kind: entry.kind, status: 'failed', error: err.message })
      log(`  ✗ ${entry.file}: ${err.message}`)
    }
    finally {
      if (tmp)
        fs.rmSync(tmp, { force: true })
    }
  }

  fs.rmSync(bundleCache, { recursive: true, force: true })
  return { game: gameId, output_dir: root, ok, failed }
}

// ---------- 预下载目录浏览 API (按需加载, 避免大响应) ----------

function loadPredownloadPayload(gameId, dataDir) {
  const p = path.join(dataDir, 'predownload', `${gameId}.json`)
  if (!fs.existsSync(p))
    return null
  // 单个 payload 实测 2.7MB (nap 2351 条), 而这个函数每次请求预下载相关接口
  // 都要走一遍; 走 mtime 缓存后首次解析后只剩一次 statSync。
  return readJsonCached(p)
}

export function predownloadSummary(gameId, dataDir) {
  const payload = loadPredownloadPayload(gameId, dataDir)
  if (!payload)
    return null
  const summary = {}
  for (const tag of payload.tags ?? []) {
    const d = payload.diffs?.[tag]
    if (d)
      summary[tag] = d.stats
  }
  return {
    game: payload.game,
    current_version: payload.current_version,
    predownload_version: payload.predownload_version,
    build_id: payload.build_id,
    generated_at: payload.generated_at,
    tags: payload.tags ?? [],
    stats: summary,
  }
}

/** 目录浏览: 返回指定目录的直接子项; q 非空时全局搜索 (限制条数) */
export function predownloadDir(gameId, dataDir, tag, dir = '', q = '') {
  const payload = loadPredownloadPayload(gameId, dataDir)
  if (!payload || !payload.diffs?.[tag])
    return null
  const dd = payload.diffs[tag]
  const entries = [
    ...dd.entries.added.map(e => ({ ...e, type: 'added' })),
    ...dd.entries.modified.map(e => ({ ...e, type: 'modified' })),
    ...dd.entries.deleted.map(e => ({ ...e, type: 'deleted' })),
  ]
  if (!entries.length)
    return { dirs: [], files: [] }

  if (q.trim()) {
    const query = q.trim().toLowerCase()
    const files = entries
      .filter(e => e.file.toLowerCase().includes(query))
      .slice(0, 300)
      .map(e => ({ file: e.file, size: e.size, md5: e.md5, type: e.type, original_file: e.original_file ?? '' }))
    return { dirs: [], files, truncated: true }
  }

  const depth = dir ? dir.split('/').length : 0
  const prefix = dir ? `${dir}/` : ''
  const dirs = new Map()
  const files = []
  for (const e of entries) {
    if (!e.file.startsWith(prefix))
      continue
    const rest = e.file.slice(prefix.length)
    const parts = rest.split('/')
    if (parts.length === 0)
      continue
    if (parts.length > 1) {
      const name = parts[0]
      const d = dirs.get(name) ?? { name, added: 0, modified: 0, deleted: 0, size: 0 }
      d[e.type]++
      d.size += e.size
      dirs.set(name, d)
    }
    else {
      files.push({ file: e.file, size: e.size, md5: e.md5, type: e.type, original_file: e.original_file ?? '', original_size: e.original_size ?? 0 })
    }
  }
  return { dirs: [...dirs.values()], files }
}

// ---------- 目标版本 chunk 索引 (浏览器端直下 / 服务器直下共用) ----------

async function getBranchesCached(gameId) {
  const game = GAMES[gameId]
  if (!game)
    throw new Error(`未知游戏: ${gameId}`)
  return getBranches(game)
}

/**
 * 确保目标版本的 chunk 索引存在 (getBuild → 解析全部 manifest → 索引文件)。
 * 索引: { file: { size, md5, chunks: [{id, offset, compressed_size, uncompressed_size, compressed_md5, uncompressed_md5}] } }
 */
export async function ensureChunkIndex(gameId, dataDir, version, log = () => {}) {
  const indexPath = path.join(dataDir, 'chunk', `${gameId}_${version}.index.json`)
  if (fs.existsSync(indexPath)) {
    // 索引可达 38MB+, 每次调用都 readFileSync + JSON.parse 实测阻塞事件循环 239ms,
    // 而这条路径每点一次"Chunk 下载"就走一次。readJsonCached 按 mtime 缓存,
    // 首次解析后只花一次 statSync。
    const cached = readJsonCached(indexPath)
    if (cached)
      return cached
    // 缓存返回 null = 文件损坏/不可读 → 落到下面重建
  }

  // 已有 getBuild 快照则直接解析, 否则拉取
  const snapshotPath = path.join(dataDir, 'chunk', `${gameId}_${version}.json`)
  let buildInfo
  if (fs.existsSync(snapshotPath)) {
    buildInfo = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
  }
  else {
    const { main, pre_download: pre } = await getBranchesCached(gameId)
    const creds = pre ?? main
    if (!creds)
      throw new Error('无构建凭据')
    log(`[${gameId}] 拉取 ${version} 的 getBuild 快照...`)
    buildInfo = await apiCall('getBuild', {
      branch: creds.branch ?? 'main',
      package_id: creds.package_id,
      password: creds.password,
    })
    // 官方 getBuild 只给「当前」构建，没有按版本回溯的接口。若拿回来的 tag 与请求
    // 版本不符，说明这个版本官方已不再提供 chunk 清单 —— 必须在这里停下，
    // 否则会把「最新版的文件清单」写成 `${gameId}_${version}.index.json`，
    // 让这个版本的索引从此永久错标。
    const tag = buildInfo.data?.tag
    if (tag && tag !== version)
      throw new Error(`官方仅提供最新构建 (${tag})，无法取得 ${version} 的 chunk 清单`)
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
    fs.writeFileSync(snapshotPath, JSON.stringify(buildInfo), 'utf-8')
  }

  const manifests = buildInfo.data?.manifests ?? []
  log(`[${gameId}] 解析 ${manifests.length} 个 manifest 构建索引...`)
  const parsed = await fetchAllManifests(buildInfo, 8)
  const index = {}
  for (let i = 0; i < parsed.length; i++) {
    const ref = manifests[i]
    const msg = ChunkManifestMsg.decode(parsed[i])
    const man = ChunkManifestMsg.toObject(msg, DECODE_OPTS)
    for (const f of man.chuncks ?? []) {
      if (f.is_folder)
        continue
      index[f.file] = {
        size: Number(f.size ?? 0),
        md5: f.md5 ?? '',
        chunks: (f.chunks ?? []).map(c => ({
          id: c.id,
          offset: Number(c.offset),
          compressed_size: Number(c.compressed_size),
          uncompressed_size: Number(c.uncompressed_size),
          compressed_md5: c.compressed_md5 ?? '',
          uncompressed_md5: c.uncompressed_md5 ?? '',
        })),
      }
    }
  }
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')
  log(`[${gameId}] chunk 索引已生成: ${Object.keys(index).length} 个文件`)
  return index
}

/** 从 getBuild 快照取 chunk 下载前缀 */
function chunkUrlPrefixOf(gameId, dataDir, version) {
  const snapshotPath = path.join(dataDir, 'chunk', `${gameId}_${version}.json`)
  if (!fs.existsSync(snapshotPath))
    return ''
  const buildInfo = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
  const ref = (buildInfo.data?.manifests ?? []).find(m => (m.chunk_download?.url_prefix ?? '').length > 0)
  return ref?.chunk_download?.url_prefix ?? ''
}

/** 预下载单文件的 chunk 直下信息 (浏览器端与文件列表页相同的方式) */
export async function predownloadChunkInfo(gameId, dataDir, file, log = () => {}) {
  const payload = loadPredownloadPayload(gameId, dataDir)
  if (!payload)
    throw new Error(`${gameId} 没有预下载数据`)
  const version = payload.predownload_version
  const index = await ensureChunkIndex(gameId, dataDir, version, log)
  const entry = index[file]
  if (!entry)
    return null

  return {
    file,
    size: entry.size,
    md5: entry.md5,
    url_prefix: chunkUrlPrefixOf(gameId, dataDir, version),
    url_suffix: '',
    chunks: entry.chunks,
  }
}

/** 按 chunk 索引下载单个文件 (校验每块大小/MD5, 输出 MD5) */
async function downloadChunkFile(chunkInfo, outPath, log) {
  const parts = []
  await mapPool(chunkInfo.chunks, 8, async (c) => {
    const url = joinUrl(chunkInfo.url_prefix, c.id, chunkInfo.url_suffix)
    const raw = await fetchBytes(url, {
      expectedSize: c.compressed_size || undefined,
      expectedMd5: c.compressed_md5 || undefined,
    })
    const data = await zstdDecompress(raw, c.uncompressed_size)
    if (c.uncompressed_md5 && md5(data) !== c.uncompressed_md5)
      throw new Error(`chunk ${c.id} 解压 MD5 不匹配`)
    parts.push({ offset: c.offset, data })
  })

  parts.sort((a, b) => a.offset - b.offset)
  const end = parts.reduce((m, p) => Math.max(m, p.offset + p.data.length), 0)
  if (end > chunkInfo.size)
    throw new Error(`chunk 数据超出文件大小`)
  const buf = Buffer.alloc(chunkInfo.size)
  let cursor = 0
  for (const p of parts) {
    if (p.offset > cursor)
      throw new Error(`chunk 空洞 @ ${cursor}`)
    Buffer.from(p.data).copy(buf, p.offset)
    cursor = Math.max(cursor, p.offset + p.data.length)
  }
  if (chunkInfo.md5 && md5(buf) !== chunkInfo.md5)
    throw new Error(`文件 MD5 不匹配: ${md5(buf)} != ${chunkInfo.md5}`)
  fs.writeFileSync(outPath, buf)
  return buf.length
}

// ---------- USM 探测与 MP4 转换 (浏览器 <video> 直接加载, 避开 fetch 大响应限制) ----------

/** 下载前 512KB 探测 USM 视频格式 (加密文件用 key 逐 chunk 解密后再判断) */
export async function detectUsmFormat(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-524287' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`)
  return detectUsmBytes(new Uint8Array(await res.arrayBuffer()), opts)
}

/** 探测 USM 字节数据的视频格式 (与 hsr_usm2mp4.py 第 4/6 步一致: 明文探测 → key 解密探测) */
export async function detectUsmBytes(usm, { game = '', file = '', dataDir = null, log = () => {} } = {}) {
  const { parseUsmChunks, makeVideoMask, decryptVideo, findVideoNonce } = await importUsmDemux()

  const check = (chunks) => {
    let checked = 0
    for (const c of chunks) {
      if (c.data.length < 8)
        continue
      const d = c.data
      if (d[0] === 0x44 && d[1] === 0x4b && d[2] === 0x49 && d[3] === 0x46)
        return 'vp9'
      if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1)
        return 'h264'
      if (d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0xb3)
        return 'mpeg1'
      if (++checked >= 4)
        break
    }
    return null
  }

  const videoChunks = parseUsmChunks(usm).filter(c => c.type === '@SFV' || c.type === 'EVID')
  const fmt = check(videoChunks)
  if (fmt)
    return fmt

  // 原始探测失败 → 尝试 key 逐 chunk 解密
  const key = findUsmKey(dataDir, game, file)
  if (typeof key === 'string' && key && key !== '0000000000000000') {
    const { mask1, mask2 } = makeVideoMask(BigInt(`0x${key}`))
    const decrypted = videoChunks.map(c => decryptVideo(c.data, mask1, mask2))
    const fmt2 = check(decrypted)
    if (fmt2) {
      log(`[usm] 加密格式探测: ${fmt2} (key ${key})`)
      return fmt2
    }
  }
  else if (key && typeof key === 'object' && key.aes) {
    // 4.5 method2 (AES-CTR): 解密首个大块后探测
    const nonce = findVideoNonce(usm)
    const first = videoChunks.find(c => c.data.length > 0x400)
    if (nonce && first) {
      const pt = decryptChunkAesCtr(first.data, Buffer.from(key.aes, 'hex'), nonce, first.frameTime)
      const fmt2 = check([{ data: pt }])
      if (fmt2) {
        log(`[usm] 加密格式探测: ${fmt2} (method2 aes, nonce=${Buffer.from(nonce).toString('hex')})`)
        return fmt2
      }
    }
  }
  return null
}

// Node 24 类型剥离可直接 import 前端 TS 模块
async function importUsmDemux() {
  return import(pathToFileURL(path.join(__dirname, '../src/utils/usm_demux.ts')).href)
}

/** 下载完整 USM → usmBytesToMp4 */
export async function usmToMp4(url, opts = {}) {
  const { log = () => {} } = opts
  log(`[usm] 下载 ${url}`)
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok)
    throw new Error(`下载失败 HTTP ${res.status}`)
  return usmBytesToMp4(new Uint8Array(await res.arrayBuffer()), opts)
}

/**
 * 解析 key 条目为统一的解密模式。
 * keys.json 值有两种形态:
 *   - "16位hex" 字符串: 全零=明文, 非零=反馈式 XOR 掩码 (4.4 体系)
 *   - { aes: "<32hex>", audio: "<16hex>" } 对象: 4.5 method2 (AES-CTR 视频 + HCA 音频)
 *     (nonce 不入库 — 每个版本文件各不相同, 从 USM 字节的 VIDEO_HDRINFO 表现读)
 */
function resolveKeyEntry(entry) {
  if (!entry)
    return { mode: 'plain' }
  if (typeof entry === 'string')
    return entry === '0000000000000000' ? { mode: 'plain' } : { mode: 'mask', keyHex: entry }
  if (typeof entry === 'object' && entry.aes)
    return { mode: 'aes', aesHex: entry.aes, audioHex: entry.audio ?? '' }
  return { mode: 'plain' }
}

/** 单 chunk 的 AES-128-CTR 解密: 计数器 = nonce(8B) ‖ frameTime(4B) ‖ 00000000, 加密区 = payload[0x40:] */
function decryptChunkAesCtr(data, aesKeyBytes, nonceBytes, frameTime) {
  if (data.length <= 0x40)
    return data
  const iv = Buffer.alloc(16)
  Buffer.from(nonceBytes).copy(iv, 0)
  iv.writeUInt32BE(frameTime >>> 0, 8)
  const dec = createDecipheriv('aes-128-ctr', aesKeyBytes, iv)
  const head = data.slice(0, 0x40)
  const body = dec.update(data.subarray(0x40))
  const tail = dec.final()
  const out = new Uint8Array(head.length + body.length + tail.length)
  out.set(head, 0)
  out.set(body, head.length)
  out.set(tail, head.length + body.length)
  return out
}

/**
 * 提取并解密视频流 (mask / aes / 明文三模式共用)。
 * 返回 { format: 'h264'|'mpeg1'|'vp9'|null, stream }。
 */
async function prepareVideoStream(usm, { game = '', file = '', dataDir = null, log = () => {} } = {}) {
  const { parseUsmChunks, makeVideoMask, decryptVideo, findVideoNonce } = await importUsmDemux()

  log(`[usm] ${usm.length} 字节, 解析容器...`)
  const videoChunks = parseUsmChunks(usm).filter(c => c.type === '@SFV' || c.type === 'EVID')
  const key = resolveKeyEntry(findUsmKey(dataDir, game, file))

  let parts
  if (key.mode === 'mask') {
    log(`[usm] 使用 key 解密 (掩码): ${key.keyHex}`)
    const { mask1, mask2 } = makeVideoMask(BigInt(`0x${key.keyHex}`))
    parts = videoChunks.map(c => decryptVideo(c.data, mask1, mask2))
  }
  else if (key.mode === 'aes') {
    const nonce = findVideoNonce(usm)
    if (!nonce)
      throw new Error('method2 视频缺少 VIDEO_HDRINFO nonce (文件不是 4.5 method2 或已损坏)')
    const aesKeyBytes = Buffer.from(key.aesHex, 'hex')
    log(`[usm] 使用 key 解密 (AES-CTR method2), nonce=${Buffer.from(nonce).toString('hex')}`)
    // 每个 dtype==0 的 @SFV 块独立 CTR: 计数器用该块自己的 frameTime; 块前 0x40 字节是明文。
    // 注意小块 (csize 可低至 ~0x100) 也是加密视频数据, 不能按大小跳过 (Act3060/520 等
    // 39 个文件的流以小块开头, 漏解 = 黑屏); @UTF 开头的块是元数据表, 原样跳过。
    parts = videoChunks.map(c => {
      const isUtfTable = c.data.length > 4 && c.data[0] === 0x40 && c.data[1] === 0x55 && c.data[2] === 0x54 && c.data[3] === 0x46
      return (!isUtfTable && c.data.length > 0x40)
        ? decryptChunkAesCtr(c.data, aesKeyBytes, nonce, c.frameTime)
        : c.data
    })
  }
  else {
    if (!findUsmKey(dataDir, game, file)) {
      // 无 key 记录: 按明文兜底 (UI 层已限制无 key 不可播放)。
      // 注意 4.5 method2 文件前 0x40 字节也是明文 h264, 明文探测会被骗 —
      // 先查 VIDEO_HDRINFO nonce: 存在且非零 = method2 加密, 直接拒绝。
      const { findVideoNonce } = await importUsmDemux()
      const nonce = findVideoNonce(usm)
      if (nonce && nonce.some(b => b !== 0))
        throw new Error('视频已加密 (method2) 且未找到对应 key')
      const rawFirst = videoChunks[0]?.data
      const looksPlain = rawFirst && rawFirst.length >= 4
        && ((rawFirst[0] === 0 && rawFirst[1] === 0 && rawFirst[2] === 0 && rawFirst[3] === 1)
          || (rawFirst[0] === 0x44 && rawFirst[1] === 0x4b && rawFirst[2] === 0x49 && rawFirst[3] === 0x46)
          || (rawFirst[0] === 0 && rawFirst[1] === 0 && rawFirst[2] === 1 && rawFirst[3] === 0xb3))
      if (!looksPlain)
        throw new Error('视频已加密且未找到对应 key (需抓包获取)')
      log('[usm] 无 key 记录, 按明文处理')
    }
    else {
      log('[usm] key 全零, 明文视频')
    }
    parts = videoChunks.map(c => c.data)
  }

  const video = concatBytes(parts)
  log(`[usm] 视频流 ${video.length} 字节`)

  let format = null
  if (video[0] === 0x44 && video[1] === 0x4b && video[2] === 0x49 && video[3] === 0x46)
    format = 'vp9'
  else if (video[0] === 0 && video[1] === 0 && video[2] === 0 && video[3] === 1)
    format = 'h264'
  else if (video[0] === 0 && video[1] === 0 && video[2] === 1 && video[3] === 0xb3)
    format = 'mpeg1'

  if (!format) {
    if (key.mode !== 'plain')
      throw new Error('解密后不是可识别的视频流 (key 可能不正确)')
    throw new Error('视频已加密且未找到对应 key (需抓包获取)')
  }
  return { format, stream: video }
}

/** MPEG1 裸流 → MP4 (H.264): 借本机 ffmpeg 转码 (4.5 TV 类小视频为明文 MPEG1)。
 *  MP4 封装器要求可寻址输出, 故走临时文件而不是管道。 */
async function transcodeMpeg1ToMp4(mpegStream, log = () => {}) {
  const { spawn } = await import('node:child_process')
  const os = await import('node:os')
  const candidates = [
    process.env.FFMPEG_PATH,
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean)
  let ffmpeg = null
  for (const c of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(c, ['-version'], { stdio: 'ignore' })
        p.on('exit', code => (code === 0 ? resolve() : reject(new Error('exit ' + code))))
        p.on('error', reject)
      })
      ffmpeg = c
      break
    }
    catch { /* 尝试下一个 */ }
  }
  if (!ffmpeg)
    throw new Error('未找到 ffmpeg (MPEG1 转码需要; 可用环境变量 FFMPEG_PATH 指定)')

  const tmpIn = path.join(os.tmpdir(), `hoyo-files_${Date.now()}.mpg`)
  const tmpOut = path.join(os.tmpdir(), `hoyo-files_${Date.now()}.mp4`)
  fs.writeFileSync(tmpIn, mpegStream)
  log('[usm] MPEG1 → MP4 转码 (ffmpeg)...')
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, [
        '-y', '-i', tmpIn,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        tmpOut,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errText = ''
      p.stderr.on('data', d => (errText += d.toString()))
      p.on('error', reject)
      p.on('exit', (code) => {
        if (code === 0)
          resolve()
        else
          reject(new Error(`ffmpeg 转码失败 (exit ${code}): ${errText.slice(-300)}`))
      })
    })
    const out = fs.readFileSync(tmpOut)
    log(`[usm] 转码完成: ${out.length} 字节`)
    return new Uint8Array(out)
  }
  finally {
    try { fs.unlinkSync(tmpIn) } catch { /* 忽略 */ }
    try { fs.unlinkSync(tmpOut) } catch { /* 忽略 */ }
  }
}

/**
 * USM 字节 → MP4 (与 hsr_usm2mp4.py 流程一致):
 *   - 只取 @SFV/EVID 视频块 (排除 @SFA 音频块)
 *   - key 决定解密方式: 字符串=掩码 XOR, 对象 {aes}=AES-CTR (4.5 method2), 全零/缺失=明文
 *   - H.264 直接封装; MPEG1 (4.5 TV 类) 借 ffmpeg 转码; VP9 抛错走流式播放
 */
export async function usmBytesToMp4(usm, { game = '', file = '', dataDir = null, log = () => {} } = {}) {
  const { annexbToMp4 } = await import(pathToFileURL(path.join(__dirname, '../src/utils/h264mux.ts')).href)

  const { format, stream: video } = await prepareVideoStream(usm, { game, file, dataDir, log })

  if (format === 'vp9')
    throw new Error('VP9 视频请使用流式播放')

  if (format === 'mpeg1') {
    const mp4 = await transcodeMpeg1ToMp4(video, log)
    log(`[usm] MP4 (转码) ${mp4.length} 字节`)
    return mp4
  }

  log(`[usm] 封装 MP4...`)
  const mp4 = annexbToMp4(video)
  log(`[usm] MP4 ${mp4.length} 字节`)
  return mp4
}

async function findFfmpeg() {
  const { spawn } = await import('node:child_process')
  const candidates = [
    process.env.FFMPEG_PATH,
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const process = spawn(candidate, ['-version'], { stdio: 'ignore' })
        process.once('error', reject)
        process.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)))
      })
      return candidate
    }
    catch {}
  }
  return null
}

function pcmToWav(pcm, sampleRate, channels) {
  const dataSize = pcm.length * 2
  const output = Buffer.alloc(44 + dataSize)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataSize, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * channels * 2, 28)
  output.writeUInt16LE(channels * 2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < pcm.length; i++)
    output.writeInt16LE(pcm[i], 44 + i * 2)
  return new Uint8Array(output)
}

// 历史 67 的 HCA 音频使用旧 mask key 的低 56 位；不能套用 67_test 的 HCA key。
function reunionHcaAudioKey(file, key) {
  const base = path.basename(String(file ?? '').replace(/\\/g, '/')).toLowerCase()
  return base === 'video_reunion_67.usm' && key.mode === 'mask' ? key.keyHex : ''
}

async function decodeAudioWav(usm, { game = '', file = '', dataDir = null, chIndex = 0, log = () => {} } = {}) {
  const { parseUsmChunks, makeAudioMask, decryptAudio } = await importUsmDemux()
  const chunks = parseUsmChunks(usm)
  const audioChunks = chunks.filter(c => c.type === '@SFA' && c.chno === chIndex)
  if (!audioChunks.length) {
    log(`[usm] 未找到 chno=${chIndex} 音频`)
    return null
  }
  const first = audioChunks[0].data
  const isHca = first.length > 4 && (first[0] & 0x7f) === 0x48 && (first[1] & 0x7f) === 0x43
  if (isHca) {
    const key = resolveKeyEntry(findUsmKey(dataDir, game, file))
    const audioKey = key.audioHex || reunionHcaAudioKey(file, key)
    if (!audioKey)
      throw new Error(`HCA 文件缺少音频 audioKey (keys.json 条目需含 audio 字段)`)
    return await decodeHcaWavInNode(concatBytes(audioChunks.map(c => c.data)), audioKey, log)
  }
  const key = resolveKeyEntry(findUsmKey(dataDir, game, file))
  const { decodeAdx } = await import(pathToFileURL(path.join(__dirname, '../src/utils/adx_decoder.ts')).href)
  const mask = key.mode === 'mask' ? makeAudioMask(BigInt(`0x${key.keyHex}`)) : null
  const parts = audioChunks.map(c => mask ? decryptAudio(c.data, mask) : c.data)
  const audio = decodeAdx(concatBytes(parts))
  return pcmToWav(audio.pcm, audio.sampleRate, audio.channels)
}

async function decodeAudioWavs(usm, { game = '', file = '', dataDir = null, chIndex = null, log = () => {} } = {}) {
  const channels = chIndex == null ? [0, 1, 2, 3] : [chIndex]
  const tracks = []
  for (const channel of channels) {
    try {
      const wav = await decodeAudioWav(usm, { game, file, dataDir, chIndex: channel, log })
      if (wav)
        tracks.push({ channel, wav })
    }
    catch (e) {
      if (chIndex != null)
        throw e
      log(`[usm] chno=${channel} 音频不可用: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!tracks.length)
    throw new Error(chIndex == null ? '未找到可用 @SFA 音频' : `未找到 chno=${chIndex} 音频`)
  return tracks
}

async function runFfmpeg(args, log) {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg)
    throw new Error('未找到 ffmpeg (VP9 7.1 导出需要; 可用 FFMPEG_PATH 指定)')
  const { spawn } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    const process = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    process.stderr.on('data', data => { stderr += data.toString() })
    process.once('error', reject)
    process.once('exit', code => {
      if (code === 0)
        resolve()
      else
        reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
  log(`[usm] ffmpeg 完成: ${args.at(-1)}`)
}

async function muxVp9WithFfmpeg(ivf, audio, container, { log = () => {} } = {}) {
  const os = await import('node:os')
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const ivfPath = path.join(os.tmpdir(), `hoyo-files_${stamp}.ivf`)
  const outputPath = path.join(os.tmpdir(), `hoyo-files_${stamp}.${container === 'webm' ? 'webm' : 'mkv'}`)
  const tracks = (Array.isArray(audio) ? audio : audio ? [{ channel: 0, wav: audio }] : []).filter(track => track?.wav)
  const wavPaths = tracks.map((_, index) => path.join(os.tmpdir(), `hoyo-files_${stamp}_${index}.wav`))
  try {
    fs.writeFileSync(ivfPath, Buffer.from(ivf))
    const args = ['-y', '-i', ivfPath]
    for (let index = 0; index < tracks.length; index++) {
      fs.writeFileSync(wavPaths[index], Buffer.from(tracks[index].wav))
      args.push('-i', wavPaths[index])
    }
    args.push('-map', '0:v:0')
    for (let index = 0; index < tracks.length; index++)
      args.push('-map', `${index + 1}:a:0`)
    args.push('-c:v', 'copy')
    if (tracks.length) {
      args.push('-c:a', container === 'webm' ? 'libopus' : 'aac')
      args.push('-b:a', container === 'webm' ? '128k' : '192k')
      const languages = ['chi', 'eng', 'jpn', 'kor']
      for (let index = 0; index < tracks.length; index++)
        args.push(`-metadata:s:a:${index}`, `language=${languages[tracks[index].channel] ?? 'und'}`)
    }
    args.push(outputPath)
    await runFfmpeg(args, log)
    return new Uint8Array(fs.readFileSync(outputPath))
  }
  finally {
    for (const filePath of [ivfPath, ...wavPaths, outputPath]) {
      try { fs.unlinkSync(filePath) } catch {}
    }
  }
}

export async function usmBytesToWebm(usm, { game = '', file = '', dataDir = null, chIndex = null, includeAudio = true, log = () => {} } = {}) {
  const { format, stream } = await prepareVideoStream(usm, { game, file, dataDir, log })
  const keyMode = resolveKeyEntry(findUsmKey(dataDir, game, file)).mode
  // 67_test 的历史回退源是旧 mask VP9；与 7.1 AES VP9 共用同一条服务器解密播放路径。
  if (format !== 'vp9' || game !== 'hk4e' || (keyMode !== 'aes' && keyMode !== 'mask'))
    throw new Error('WebM 导出仅支持原神 VP9 视频')
  const audio = includeAudio ? await decodeAudioWavs(usm, { game, file, dataDir, chIndex, log }) : []
  return await muxVp9WithFfmpeg(stream, audio, 'webm', { log })
}

/**
 * USM 字节 → MKV (H.264 视频 + 音频, 崩铁导出用):
 *   - 视频: 与 usmBytesToMp4 相同的解密/提取逻辑 (掩码 / 4.5 AES-CTR / 明文)
 *   - 音频: @SFA 按 chno 分流, 两种格式:
 *       ADX (4.4 / 4.5 明文类) → 音频掩码 XOR (仅字符串 key) → decodeAdx → PCM
 *       HCA (4.5 method2 剧情类, magic 最高位混淆) → 拼装 HCA 流 → wasm decode_hca(audioKey) → WAV → PCM
 *   - 无音频/解密失败时抛错 (调用方降级为纯视频 WebM)
 * @param chIndex 音频通道下标 (0=第一语言...), 默认 0
 */
export async function usmBytesToMkv(usm, { game = '', file = '', dataDir = null, chIndex = null, log = () => {} } = {}) {
  const { parseUsmChunks, makeAudioMask, decryptAudio } = await importUsmDemux()
  const h264Mod = await import(pathToFileURL(path.join(__dirname, '../src/utils/h264mux.ts')).href)
  const { splitAnnexBToFrames, parseSps, makeAvcC } = h264Mod
  const { muxMkv } = await import(pathToFileURL(path.join(__dirname, '../src/utils/mkvmux.ts')).href)

  // ---- 视频 ----
  const { format, stream: video } = await prepareVideoStream(usm, { game, file, dataDir, log })
  if (format === 'vp9') {
    const keyMode = resolveKeyEntry(findUsmKey(dataDir, game, file)).mode
    if (game === 'hk4e' && (keyMode === 'aes' || keyMode === 'mask')) {
      const audio = await decodeAudioWavs(usm, { game, file, dataDir, chIndex, log })
      return await muxVp9WithFfmpeg(video, audio, 'mkv', { log })
    }
    throw new Error('VP9 视频请使用流式播放')
  }
  if (video[0] === 0 && video[1] === 0 && video[2] === 1 && video[3] === 0xb3)
    throw new Error('MPEG1 视频请使用 MP4 转码导出')
  if (!(video[0] === 0 && video[1] === 0 && video[2] === 0 && video[3] === 1))
    throw new Error('解密后不是 H.264 视频流')

  const frames = splitAnnexBToFrames(video)
  if (!frames.length)
    throw new Error('无视频帧')

  // SPS/PPS (第一个 access unit 内)
  let sps = null
  let pps = null
  for (const nal of frames[0]) {
    const t = nal[0] & 0x1f
    if (t === 7 && !sps)
      sps = nal
    else if (t === 8 && !pps)
      pps = nal
  }
  if (!sps || !pps)
    throw new Error('缺少 SPS/PPS')
  const spsInfo = parseSps(sps)
  const fps = spsInfo.fps >= 1 && spsInfo.fps <= 120 ? spsInfo.fps : 30

  // 每帧转成带 start code 的 Annex-B (mkvmux 内部转 AVCC)
  const videoFrames = frames.map(group => {
    let size = 0
    for (const nal of group)
      size += 3 + nal.length
    const buf = new Uint8Array(size)
    let off = 0
    for (const nal of group) {
      buf[off++] = 0
      buf[off++] = 0
      buf[off++] = 1
      buf.set(nal, off)
      off += nal.length
    }
    return buf
  })

  // ---- 音频: @SFA 按 chno 汇总, ADX / HCA 双格式 ----
  const chunks = parseUsmChunks(usm)
  const audioChannel = chIndex ?? 0
  const audioChunks = chunks.filter(c => c.type === '@SFA' && c.chno === audioChannel)
  if (!audioChunks.length)
    throw new Error(`未找到 chno=${audioChannel} 的 @SFA 音频块`)
  const firstA = audioChunks[0].data
  const isHca = firstA.length > 4 && (firstA[0] & 0x7f) === 0x48 && (firstA[1] & 0x7f) === 0x43

  let audio
  if (isHca) {
    // 4.5 method2: HCA (type56 子帧加密, keycode=audioKey) → wasm 解码出 WAV → PCM
    const key = resolveKeyEntry(findUsmKey(dataDir, game, file))
    if (!key.audioHex)
      throw new Error(`method2 文件缺少音频 audioKey (keys.json 条目需含 audio 字段)`)
    const hca = concatBytes(audioChunks.map(c => c.data))
    const wav = await decodeHcaWavInNode(hca, key.audioHex, log)
    audio = parseWavPcm(wav)
    log(`[usm] 音频(HCA) chno=${audioChannel}: ${audio.channels}ch ${audio.sampleRate}Hz ${(audio.totalSamples / audio.sampleRate).toFixed(2)}s`)
  }
  else {
    // ADX: 4.4 加密文件用视频 key 派生的音频掩码; 4.5 明文文件 (对象 key/全零) 不解密
    const key = resolveKeyEntry(findUsmKey(dataDir, game, file))
    const { decodeAdx } = await import(pathToFileURL(path.join(__dirname, '../src/utils/adx_decoder.ts')).href)
    const audioMask = key.mode === 'mask' ? makeAudioMask(BigInt(`0x${key.keyHex}`)) : null
    const audioParts = audioChunks.map(c => audioMask ? decryptAudio(c.data, audioMask) : c.data)
    const adx = concatBytes(audioParts)
    audio = decodeAdx(adx)
    log(`[usm] 音频(ADX) chno=${audioChannel}: ${audio.channels}ch ${audio.sampleRate}Hz ${(audio.totalSamples / audio.sampleRate).toFixed(2)}s`)
  }

  // ---- MKV 封装 ----
  log(`[usm] 封装 MKV...`)
  const mkv = muxMkv(
    {
      frames: videoFrames,
      width: spsInfo.width,
      height: spsInfo.height,
      fps,
      codecPrivate: makeAvcC(sps, pps),
      codec: 'h264',
    },
    {
      pcm: audio.pcm,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    },
  )
  log(`[usm] MKV ${mkv.length} 字节`)
  return mkv
}

/** 在 Node 里跑前端 wasm 的 decode_hca: 输入 [HCA 流], 输出 WAV 字节 */
async function decodeHcaWavInNode(hcaBytes, audioKeyHex, log = () => {}) {
  const dir = path.join(__dirname, '../src/assets/usm/')
  const glue = await import(pathToFileURL(path.join(dir, 'usm_decoder.js')).href)
  glue.initSync({ module: new Uint8Array(fs.readFileSync(path.join(dir, 'usm_decoder_bg.wasm'))) })
  const wav = glue.decode_hca([hcaBytes], audioKeyHex)
  if (!wav || !wav.length || wav[0] !== 0x52 || wav[1] !== 0x49)
    throw new Error('HCA 解码失败 (audioKey 可能不正确)')
  return wav
}

/** 极简 WAV (RIFF/pcm_s16le) 解析 → { pcm: Int16Array, sampleRate, channels, totalSamples } */
function parseWavPcm(wav) {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (wav.length < 44 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645)
    throw new Error('HCA 解码输出不是 WAV')
  let pos = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (pos + 8 <= wav.length) {
    const id = dv.getUint32(pos, false)
    const size = dv.getUint32(pos + 4, true)
    if (id === 0x666d7420)
      fmt = { channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) }
    else if (id === 0x64617461) { dataOff = pos + 8; dataLen = size; break }
    pos += 8 + size + (size & 1)
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16)
    throw new Error('WAV 格式不支持 (需 16bit PCM)')
  const samples = Math.floor(dataLen / 2 / fmt.channels)
  const pcm = new Int16Array(samples * fmt.channels)
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = dv.getInt16(dataOff + i * 2, true)
  return { pcm, sampleRate: fmt.sampleRate, channels: fmt.channels, totalSamples: samples }
}

function concatBytes(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const jsonCache = new Map()

/** 读 JSON（按 mtime 缓存，避免每次请求都重复解析同一个大文件） */
function readJsonCached(file) {
  try {
    const mtimeMs = fs.statSync(file).mtimeMs
    const hit = jsonCache.get(file)
    if (hit && hit.mtimeMs === mtimeMs)
      return hit.data
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    jsonCache.set(file, { mtimeMs, data })
    return data
  }
  catch {
    return null
  }
}

/**
 * 按路径的 key 覆盖表 {game}_keys_by_path.json（可选）:
 *   { "keys": { "相对视频根且去掉 .usm 的路径": key条目 } }
 * 绝区零存在同名但内容不同的视频（Transfer/HollowLoading/* 与 Yorozuya/* 等），
 * 官方给它们配了**不同**的 key，而 keys.json 只能按文件名存一把 —— 靠本表区分。
 */
function loadUsmPathKeys(dataDir, game) {
  if (!dataDir || !game)
    return null
  const j = readJsonCached(path.join(dataDir, 'usm', `${game}_keys_by_path.json`))
  if (!j || typeof j !== 'object')
    return null
  const map = (j.keys && typeof j.keys === 'object') ? j.keys : j
  const entries = Object.entries(map).filter(([k, v]) => k && typeof k === 'string' && typeof v === 'string' && v)
  return entries.length ? entries : null
}

/** 在路径覆盖表里匹配：整段路径相同，或给出的路径以表内条目结尾（兼容带前缀/绝对路径） */
function matchPathKey(entries, file) {
  const noExt = String(file).replace(/\\/g, '/').replace(/\.usm$/i, '')
  const low = noExt.toLowerCase()
  for (const [k, v] of entries) {
    const kk = String(k).replace(/\\/g, '/').replace(/\.usm$/i, '').toLowerCase()
    if (low === kk || low.endsWith(`/${kk}`))
      return v
  }
  return undefined
}

/**
 * 查文件名/路径对应的 key 原始条目 (16位hex 字符串 或 {aes,audio} 对象)。
 * 顺序: 路径覆盖表(精确到目录) → {game}_keys.json(纯文件名)。
 * 同名不同内容的视频必须靠路径命中，否则会拿到另一个同名文件的 key。
 */
function findUsmKey(dataDir, game, file) {
  if (!dataDir || !game || !file)
    return ''
  try {
    const pathKeys = loadUsmPathKeys(dataDir, game)
    if (pathKeys) {
      const hit = matchPathKey(pathKeys, file)
      if (hit !== undefined)
        return hit
    }
    const base = path.basename(String(file).replace(/\\/g, '/')).replace(/\.usm$/i, '')
    const keys = readJsonCached(path.join(dataDir, 'usm', `${game}_keys.json`))
    return (keys && keys[base]) ?? ''
  }
  catch {
    return ''
  }
}

/**
 * 从 chunk CDN 组装 USM 文件 (直链失效/过期时的回退路径)。
 * version 留空时自动取该游戏本地最新版本。
 */
export async function assembleUsmFromChunks(gameId, file, { version = '', dataDir = null, log = () => {} } = {}) {
  if (!dataDir || !gameId || !file)
    throw new Error('缺少 game/file 参数')
  if (!version) {
    const versionsPath = path.join(dataDir, `${gameId}_versions.json`)
    if (fs.existsSync(versionsPath)) {
      const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'))
      // 裸 sort() 是字典序, 会把 '1.9.0' 排在 '1.10.0' 之后而选错版本
      version = Object.keys(versions).sort(compareVersions).at(-1) ?? ''
    }
  }
  if (!version)
    throw new Error('无可用版本')
  const index = await ensureChunkIndex(gameId, dataDir, version, log)
  const entry = index[file]
  if (!entry)
    throw new Error(`文件不在 ${version} 的 chunk 清单中（该文件可能已从该版本 CDN 下架，且本地游戏目录未找到）`)
  const chunkInfo = {
    file,
    size: entry.size,
    md5: entry.md5,
    url_prefix: chunkUrlPrefixOf(gameId, dataDir, version),
    url_suffix: '',
    chunks: entry.chunks,
  }
  if (!chunkInfo.url_prefix)
    throw new Error(`版本 ${version} 缺少 chunk 下载前缀`)
  const tmpPath = path.join(dataDir, 'usm', `_tmp_${gameId}_${Date.now()}.usm`)
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true })
  try {
    await downloadChunkFile(chunkInfo, tmpPath, log)
    log(`[usm] chunk 组装完成: ${file} (${chunkInfo.size} 字节)`)
    return fs.readFileSync(tmpPath)
  }
  finally {
    try { fs.unlinkSync(tmpPath) } catch { /* 忽略 */ }
  }
}

export function gameStatus(dataDir) {
  const status = {}
  for (const [id, game] of Object.entries(GAMES)) {
    const item = { name: game.name, versions: 0, latest_version: null, predownload: null }
    const vp = path.join(dataDir, `${id}_versions.json`)
    if (fs.existsSync(vp)) {
      try {
        const versions = Object.keys(JSON.parse(fs.readFileSync(vp, 'utf-8')))
        item.versions = versions.length
        // 裸 sort() 是字典序, 会把 '1.9.0' 排在 '1.10.0' 之后而选错版本
        item.latest_version = [...versions].sort(compareVersions).at(-1) ?? null
      }
      catch { /* 忽略 */ }
    }
    const pp = path.join(dataDir, 'predownload', `${id}.json`)
    if (fs.existsSync(pp)) {
      try {
        const d = JSON.parse(fs.readFileSync(pp, 'utf-8'))
        item.predownload = {
          version: d.predownload_version ?? null,
          generated_at: d.generated_at ?? null,
          tags: d.tags ?? [],
        }
      }
      catch { /* 忽略 */ }
    }
    status[id] = item
  }
  return status
}
