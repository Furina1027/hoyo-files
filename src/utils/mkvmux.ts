/**
 * 极简 Matroska (MKV/WebM) 封装器 — 纯 JS, 无依赖
 *
 * 用途: 崩铁 H.264 USM 导出 MKV 时, 把视频帧流 + ADX 解码的 PCM 音轨
 *       合成一个带音频的标准 MKV (VLC/ffprobe 可直接播放)。
 *
 * 结构:
 *   EBML header
 *   Segment
 *     ├─ Info (TimestampScale=1ms, Duration)
 *     ├─ Tracks (视频 track + PCM 音频 track)
 *     └─ Cluster × N (每 1 秒一个, 含视频 SimpleBlock + 音频 SimpleBlock)
 */

// ---------- EBML 基础工具 ----------

/** 给无符号整数写可变长编码 (EBML vint) */
function vintSize(v: number): number {
  if (v < 0x80) return 1
  if (v < 0x4000) return 2
  if (v < 0x200000) return 3
  if (v < 0x10000000) return 4
  return 5
}

function writeVint(v: number, size?: number): Uint8Array {
  const len = size ?? vintSize(v)
  const out = new Uint8Array(len)
  let x = v
  for (let i = len - 1; i >= 0; i--) {
    out[i] = x & 0xff
    x = Math.floor(x / 256)
  }
  // 首个字节的标记位: 1B→0x80, 2B→0x40, 3B→0x20, 4B→0x10
  out[0] |= 0x80 >> (len - 1)
  return out
}

/** EBML 元素: id + vint size + payload */
function ebml(id: number, payload: Uint8Array): Uint8Array {
  const idBytes = new Uint8Array(4)
  idBytes[3] = id & 0xff
  idBytes[2] = (id >> 8) & 0xff
  idBytes[1] = (id >> 16) & 0xff
  idBytes[0] = (id >> 24) & 0xff
  // 去掉前导 0
  let start = 0
  while (start < 3 && idBytes[start] === 0)
    start++
  const idPart = idBytes.slice(start)
  const sizePart = writeVint(payload.length)
  const out = new Uint8Array(idPart.length + sizePart.length + payload.length)
  out.set(idPart, 0)
  out.set(sizePart, idPart.length)
  out.set(payload, idPart.length + sizePart.length)
  return out
}

function ebmlUint(id: number, value: number | bigint): Uint8Array {
  const buf = new Uint8Array(8)
  const dv = new DataView(buf.buffer)
  dv.setBigUint64(0, BigInt(value))
  // 去掉前导 0
  let start = 0
  while (start < 7 && buf[start] === 0)
    start++
  return ebml(id, buf.slice(start))
}

function ebmlFloat(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setFloat64(0, value, false)
  return ebml(id, buf)
}

function ebmlStr(id: number, s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++)
    b[i] = s.charCodeAt(i)
  return ebml(id, b)
}

// ---------- SimpleBlock ----------
// [track vint][int16 timecode][flags][payload]
function simpleBlock(track: number, timecodeMs: number, isKeyframe: boolean, payload: Uint8Array): Uint8Array {
  const trackPart = writeVint(track)
  const tc = Math.round(timecodeMs)
  const head = new Uint8Array(2 + trackPart.length)
  head.set(trackPart, 0)
  new DataView(head.buffer).setInt16(trackPart.length, tc, false)
  const flags = isKeyframe ? 0x80 : 0x00
  const body = new Uint8Array(2 + trackPart.length + 1 + payload.length)
  body.set(head, 0)
  body[2 + trackPart.length] = flags
  body.set(payload, 3 + trackPart.length)
  return ebml(0xA3, body)
}

// ---------- 主入口 ----------

export interface MkvVideoInfo {
  /** 每帧一个 access unit (H.264: Annex-B 格式含 start code, 内部转 AVCC; VP9: 原始 VP9 帧) */
  frames: Uint8Array[]
  width: number
  height: number
  fps: number
  /** avcC (H.264) 或 VP9 codec private */
  codecPrivate: Uint8Array
  /** 'h264' | 'vp9' */
  codec: 'h264' | 'vp9'
}

export interface MkvAudioInfo {
  /** 交错 PCM Int16 */
  pcm: Int16Array
  sampleRate: number
  channels: number
}

/** 组装完整 MKV 字节流 */
export function muxMkv(video: MkvVideoInfo, audio: MkvAudioInfo | null): Uint8Array {
  const { frames, width, height, fps, codecPrivate } = video
  const frameDurationMs = Math.round(1000 / fps)

  // 视频总时长 (ms), 最小 1 帧
  const videoDurationMs = frames.length * frameDurationMs
  // 音频总时长 (ms)
  const audioDurationMs = audio
    ? Math.round((audio.pcm.length / audio.channels / audio.sampleRate) * 1000)
    : 0
  const durationMs = Math.max(videoDurationMs, audioDurationMs, 1)

  // ---- Tracks ----
  const videoTrack = (() => {
    const entries: Uint8Array[] = [
      ebmlUint(0xD7, 1),       // TrackNumber
      ebmlUint(0x73C5, 1),     // TrackUID
      ebmlUint(0x83, 1),       // TrackType = video
      ebmlStr(0x86, video.codec === 'h264' ? 'V_MPEG4/ISO/AVC' : 'V_VP9'), // CodecID
      ebml(0x63A2, codecPrivate), // CodecPrivate
      ebml(0xE0, concat([
        ebmlUint(0xB0, width),     // PixelWidth
        ebmlUint(0xBA, height),    // PixelHeight
      ])), // Video
    ]
    return ebml(0xAE, concat(entries)) // TrackEntry
  })()

  const audioTrack = audio ? (() => {
    const entries: Uint8Array[] = [
      ebmlUint(0xD7, 2),       // TrackNumber
      ebmlUint(0x73C5, 2),     // TrackUID
      ebmlUint(0x83, 2),       // TrackType = audio
      ebmlStr(0x86, 'A_PCM/INT/LIT'), // CodecID: 16-bit LE 交错 PCM
      ebml(0xE1, concat([
        ebmlFloat(0xB5, audio.sampleRate), // SamplingFrequency
        ebmlUint(0x9F, audio.channels),    // Channels
        ebmlUint(0x6264, 16),              // BitDepth
      ])), // Audio
    ]
    return ebml(0xAE, concat(entries))
  })() : null

  const tracks = ebml(0x1654AE6B, concat(audio ? [videoTrack, audioTrack] : [videoTrack]))

  // ---- Clusters: 每 1 秒一个 cluster, 容纳该秒内全部视频帧 + 音频块 ----
  const clusterSpanMs = 1000
  const clusters: Uint8Array[] = []
  const numClusters = Math.ceil(durationMs / clusterSpanMs)

  // H.264: 每帧 Annex-B → AVCC (4 字节长度前缀), Matroska 标准存储格式
  const videoBlocks = video.codec === 'h264'
    ? frames.map(annexBToAvcc)
    : frames

  for (let ci = 0; ci < numClusters; ci++) {
    const clusterStartMs = ci * clusterSpanMs
    const blocks: Uint8Array[] = []

    // 视频帧
    for (let fi = 0; fi < videoBlocks.length; fi++) {
      const frameTimeMs = fi * frameDurationMs
      if (frameTimeMs < clusterStartMs || frameTimeMs >= clusterStartMs + clusterSpanMs)
        continue
      const tc = frameTimeMs - clusterStartMs
      // I 帧判定: 首帧 (第 0 帧) 或包含 IDR (nal type 5)
      const isKey = isKeyframeNal(frames[fi])
      blocks.push(simpleBlock(1, tc, isKey, videoBlocks[fi]))
    }

    // 音频块 (每 cluster 一个, timecode=0, 覆盖该秒 PCM)
    if (audio) {
      const samplesPerCluster = audio.sampleRate * clusterSpanMs / 1000
      const startSample = ci * samplesPerCluster
      const endSample = Math.min(startSample + samplesPerCluster, audio.pcm.length / audio.channels)
      if (endSample > startSample) {
        const slice = new Int16Array((endSample - startSample) * audio.channels)
        slice.set(audio.pcm.subarray(startSample * audio.channels, endSample * audio.channels))
        const bytes = new Uint8Array(slice.length * 2)
        for (let i = 0; i < slice.length; i++) {
          bytes[i * 2] = slice[i] & 0xff
          bytes[i * 2 + 1] = (slice[i] >> 8) & 0xff
        }
        blocks.push(simpleBlock(2, 0, true, bytes))
      }
    }

    if (blocks.length) {
      clusters.push(ebml(0x1F43B675, concat([
        ebmlUint(0xE7, clusterStartMs), // Cluster Timestamp
        ...blocks,
      ])))
    }
  }

  // ---- 组装 ----
  const ebmlHeader = concat([
    ebmlUint(0x4286, 1),   // EBMLVersion
    ebmlUint(0x42F7, 1),   // EBMLReadVersion
    ebmlUint(0x42F2, 4),   // EBMLMaxIDLength
    ebmlUint(0x42F3, 8),   // EBMLMaxSizeLength
    ebmlStr(0x4282, 'matroska'), // DocType
    ebmlUint(0x4287, 4),   // DocTypeVersion
    ebmlUint(0x4285, 2),   // DocTypeReadVersion
  ])
  const ebmlRoot = ebml(0x1A45DFA3, ebmlHeader)

  const info = ebml(0x1549A966, concat([
    ebmlUint(0x2AD7B1, 1000000),       // TimestampScale = 1ms
    ebmlFloat(0x4489, durationMs),       // Duration = 时间刻度数 (ms = durationMs)
    ebmlStr(0x4D80, 'hoyo-files'),       // MuxingApp
    ebmlStr(0x5741, 'hoyo-files'),       // WritingApp
  ]))

  const segment = ebml(0x18538067, concat([info, tracks, ...clusters]))

  const out = new Uint8Array(ebmlRoot.length + segment.length)
  out.set(ebmlRoot, 0)
  out.set(segment, ebmlRoot.length)
  return out
}

/** Annex-B (00 00 01 start code) → AVCC (4 字节长度前缀) */
function annexBToAvcc(frame: Uint8Array): Uint8Array {
  // 收集所有 NAL
  const nalus: Uint8Array[] = []
  let i = 0
  const len = frame.length
  while (i < len) {
    let start = -1
    for (let j = i; j + 3 < len; j++) {
      if (frame[j] === 0 && frame[j + 1] === 0 && (frame[j + 2] === 1 || (frame[j + 2] === 0 && frame[j + 3] === 1))) {
        start = j
        break
      }
    }
    if (start < 0)
      break
    let end = start + 3
    if (frame[start + 2] === 0)
      end = start + 4
    let next = len
    for (let j = end; j + 3 < len; j++) {
      if (frame[j] === 0 && frame[j + 1] === 0 && (frame[j + 2] === 1 || (frame[j + 2] === 0 && frame[j + 3] === 1))) {
        next = j
        break
      }
    }
    nalus.push(frame.slice(end, next))
    i = next
  }

  const out = new Uint8Array(nalus.reduce((s, n) => s + 4 + n.length, 0))
  let off = 0
  for (const nal of nalus) {
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(off, nal.length)
    off += 4
    out.set(nal, off)
    off += nal.length
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---------- EBML 解析 (用于给 wasm 输出的 WebM 注入音频轨) ----------

interface EbmlElement {
  id: number
  start: number // 元素起始 (含 id)
  headerEnd: number // data 起始
  size: number // data 大小 (unknown 时为 -1)
  dataStart: number
  dataEnd: number
}

/**
 * 读取 EBML 元素 ID (vint, 原始字节值含标记位)
 * 注意: ID 与 size 的 vint 编码不同 — ID 保留标记位, size 移除标记位
 */
function readEbmlId(data: Uint8Array, pos: number): { value: number, len: number } {
  const first = data[pos]
  let len = 1
  while (len <= 4 && !(first & (0x80 >> (len - 1))))
    len++
  let value = first
  for (let i = 1; i < len; i++)
    value = (value << 8) | data[pos + i]
  return { value, len }
}

/** 读取 EBML 元素 size (vint, 移除标记位) */
function readEbmlSize(data: Uint8Array, pos: number): { value: number, len: number } {
  const first = data[pos]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1))))
    len++
  let value = first & (0xff >> len)
  for (let i = 1; i < len; i++)
    value = (value << 8) | data[pos + i]
  return { value, len }
}

/** 已知的容器元素 ID (只有容器内部才有子元素; 标量元素的 data 是原始字节, 不能递归解析) */
const EBML_CONTAINER_IDS = new Set<number>([
  0x18538067, // Segment
  0x1549A966, // Info
  0x1654AE6B, // Tracks
  0xAE,       // TrackEntry
  0x1F43B675, // Cluster
  0x114D9B74, // SeekHead
  0x4DBB,     // SeekEntry
  0xA0,       // BlockGroup
  0x1C53BB6B, // Cues
  0x1254C367, // Tags
  0xE0,       // Video
  0xE1,       // Audio
])

/** 扁平解析 EBML 元素 (仅递归进入已知容器), 返回按位置排序的列表 */
function parseEbml(data: Uint8Array, start = 0, end = data.length): EbmlElement[] {
  const out: EbmlElement[] = []
  let pos = start
  while (pos + 2 <= end) {
    const idInfo = readEbmlId(data, pos)
    const id = idInfo.value
    const idLen = idInfo.len
    let size = -1
    let sizeLen = 0
    if (pos + idLen < end) {
      const szInfo = readEbmlSize(data, pos + idLen)
      size = szInfo.value
      sizeLen = szInfo.len
      // all-ones = unknown size
      if (sizeLen === 8 && data[pos + idLen] === 0xff)
        size = -1
    }
    const headerEnd = pos + idLen + sizeLen
    const el: EbmlElement = {
      id,
      start: pos,
      headerEnd,
      size,
      dataStart: headerEnd,
      dataEnd: size >= 0 ? Math.min(headerEnd + size, end) : end,
    }
    out.push(el)
    if (size === 0) {
      pos = headerEnd
    }
    else if (size > 0) {
      // 仅对容器元素递归 (标量元素的 data 是原始字节, 可能碰巧像元素 ID, 不能误解析)
      if (EBML_CONTAINER_IDS.has(id) && size >= 2 && el.dataEnd > el.dataStart) {
        out.push(...parseEbml(data, el.dataStart, el.dataEnd))
      }
      pos = el.dataEnd
    }
    else {
      // unknown size: 尝试解析到末尾 (Segment 通常 unknown)
      if (end - headerEnd >= 2) {
        out.push(...parseEbml(data, headerEnd, end))
      }
      pos = end
    }
  }
  return out
}

/**
 * 给 wasm 输出的 WebM (init_segment + clusters) 注入 PCM 音频轨
 * 返回完整 MKV 字节 (视频轨保持原样)
 */
export function injectPcmAudioToWebm(
  webmParts: Uint8Array[],
  audio: MkvAudioInfo,
): Uint8Array {
  const webm = concat(webmParts)
  const els = parseEbml(webm)

  // 找 Segment 和其中的 Tracks
  const segment = els.find(e => e.id === 0x18538067) // Segment
  if (!segment || segment.size < 0)
    throw new Error('无法解析 wasm 输出的 WebM (无 Segment)')
  const tracks = els.find(e => e.id === 0x1654AE6B && e.start > segment.dataStart && e.dataEnd <= segment.dataEnd) // Tracks
  if (!tracks)
    throw new Error('无法解析 wasm 输出的 WebM (无 Tracks)')

  // 构建音频 TrackEntry (track number = 2)
  const audioTrackEntry = (() => {
    const entries: Uint8Array[] = [
      ebmlUint(0xD7, 2),       // TrackNumber
      ebmlUint(0x73C5, 2),     // TrackUID
      ebmlUint(0x83, 2),       // TrackType = audio
      ebmlStr(0x86, 'A_PCM/INT/LIT'),
      ebml(0xE1, concat([
        ebmlFloat(0xB5, audio.sampleRate),
        ebmlUint(0x9F, audio.channels),
        ebmlUint(0x6264, 16),
      ])),
    ]
    return ebml(0xAE, concat(entries))
  })()

  // 重建 Tracks: 原内容 + 音频 TrackEntry
  const oldTracksTotalLen = tracks.dataEnd - tracks.start
  const newTracks = ebml(0x1654AE6B, concat([
    webm.slice(tracks.dataStart, tracks.dataEnd),
    audioTrackEntry,
  ]))
  const delta = newTracks.length - oldTracksTotalLen // Tracks 之后的元素偏移增量

  // 音频 clusters: 每 1 秒一个 cluster, timecode 从 0 起
  const audioClusters = buildAudioClusters(audio)

  // 组装: Segment data 中 Tracks 之前 (跳过 SeekHead, 其 SeekPosition 偏移会失效且可省略) + 新 Tracks + Tracks 之后 (含原 clusters) + 音频 clusters
  const seekHead = els.find(e => e.id === 0x114D9B74 && e.start >= segment.dataStart && e.dataEnd <= segment.dataEnd)
  const segBefore = webm.slice(segment.dataStart, tracks.start)
  const segAfter = webm.slice(tracks.dataEnd, segment.dataEnd)
  const newSegmentBody = concat([
    seekHead
      ? concat([segBefore.slice(0, seekHead.start - segment.dataStart), segBefore.slice(seekHead.dataEnd - segment.dataStart)])
      : segBefore,
    newTracks,
    segAfter,
    ...audioClusters,
  ])
  const newSegment = ebml(0x18538067, newSegmentBody)

  // EBML header 保持原样
  const ebmlHeader = webm.slice(0, segment.start)
  const out = new Uint8Array(ebmlHeader.length + newSegment.length)
  out.set(ebmlHeader, 0)
  out.set(newSegment, ebmlHeader.length)
  return out
}

/** 生成 PCM 音频 clusters (每 1 秒一个, timecode 递增) */
function buildAudioClusters(audio: MkvAudioInfo): Uint8Array[] {
  const { pcm, sampleRate, channels } = audio
  const clusterSpanMs = 1000
  const totalSamples = Math.floor(pcm.length / channels)
  const numClusters = Math.ceil(totalSamples / sampleRate)
  const clusters: Uint8Array[] = []
  for (let ci = 0; ci < numClusters; ci++) {
    const startSample = ci * sampleRate
    const endSample = Math.min(startSample + sampleRate, totalSamples)
    if (endSample <= startSample)
      break
    const slice = new Int16Array((endSample - startSample) * channels)
    slice.set(pcm.subarray(startSample * channels, endSample * channels))
    const bytes = new Uint8Array(slice.length * 2)
    for (let i = 0; i < slice.length; i++) {
      bytes[i * 2] = slice[i] & 0xff
      bytes[i * 2 + 1] = (slice[i] >> 8) & 0xff
    }
    const tc = ci * clusterSpanMs
    clusters.push(ebml(0x1F43B675, concat([
      ebmlUint(0xE7, tc),
      simpleBlock(2, 0, true, bytes),
    ])))
  }
  return clusters
}

/** 判断 H.264 NAL 是否为关键帧 (含 IDR, nal type 5) */
function isKeyframeNal(frame: Uint8Array): boolean {
  // 扫描 start code 之后的 nal header
  let i = 0
  while (i + 3 < frame.length) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
      const t = frame[i + 3] & 0x1f
      if (t === 5)
        return true
      i += 4
    }
    else if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 0 && frame[i + 3] === 1) {
      const t = frame[i + 4] & 0x1f
      if (t === 5)
        return true
      i += 5
    }
    else {
      i++
    }
  }
  return false
}