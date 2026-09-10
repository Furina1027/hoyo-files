/**
 * USM (CRIWARE) 容器解析 — 从 PyCriUsm fast_core.pyx 移植
 *
 * 容器结构 (新格式):
 *   每个 chunk: 24 字节头 + 数据区
 *     [0:4]   chunk_type (BE): "CRID" 文件头 / "@SFV" 流数据表 ...
 *     [4:8]   chunk_size (BE)
 *     [9]     data_offset
 *     [10:12] padding (BE)
 *     [15]&3  data_type: 0 = 流数据 (视频/音频), 非 0 = 元数据表
 *   流数据 = data[pos + data_offset + 8 : pos + chunk_size - padding]
 *
 * 视频流 = 所有 data_type==0 的 chunk 数据按序拼接:
 *   - VP9 加密: 需 XOR 掩码解密后为 IVF 流
 *   - H.264 未加密: 直接是 Annex-B 裸流
 */

export interface UsmChunk {
  type: string
  isVideo: boolean
  chno: number
  data: Uint8Array
  /** chunk 头 [0x10:0x14] 的 frameTime (大端) — 4.5 AES-CTR 解密的计数器组成部分 */
  frameTime: number
}

/**
 * keys.json 条目类型:
 *   - "16位hex" 字符串: 全零=明文, 非零=反馈式 XOR 掩码 key (4.4 体系, 视频+音频共用)
 *   - { aes, audio } 对象: 4.5 method2 — aes=视频 AES-128-CTR 密钥 (32位hex),
 *     audio=HCA 音频 keycode (16位hex); nonce 不入库, 从 USM 的 VIDEO_HDRINFO 现读
 */
export type UsmKeyEntry = string | { aes: string, audio?: string }

export function parseUsmChunks(data: Uint8Array): UsmChunk[] {
  const chunks: UsmChunk[] = []
  let pos = 0
  const fileSize = data.length
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)

  while (pos + 24 <= fileSize) {
    const chunkType = dv.getUint32(pos, false)
    const chunkSize = dv.getUint32(pos + 4, false)
    if (chunkSize === 0 || pos + chunkSize + 8 > fileSize)
      break
    const dataOffset = data[pos + 9]
    const padding = dv.getUint16(pos + 10, false)
    const chno = data[pos + 12]
    const dataType = data[pos + 15] & 3
    const nextPos = pos + chunkSize + 8

    if (dataType === 0) {
      const start = pos + dataOffset + 8
      const size = chunkSize - dataOffset - padding
      const typeStr = String.fromCharCode(
        data[pos] & 0x7f, data[pos + 1] & 0x7f, data[pos + 2] & 0x7f, data[pos + 3] & 0x7f,
      )
      chunks.push({
        type: typeStr,
        isVideo: typeStr === 'EVID',
        chno,
        data: data.slice(start, start + size),
        frameTime: dv.getUint32(pos + 16, false),
      })
    }
    pos = nextPos
  }
  return chunks
}

/** 提取视频流: 全部 data_type==0 chunk 拼接 (加密视频需先 decryptVideo) */
export function extractVideoStream(data: Uint8Array): Uint8Array {
  const chunks = parseUsmChunks(data)
  const parts = chunks.map(c => c.data)
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 视频掩码生成 (PyCriUsm UsmCrypter): key 为 0 表示未加密 */
export function makeVideoMask(key: bigint): { mask1: Uint8Array, mask2: Uint8Array } {
  const key1 = Number(key & 0xffffffffn)
  const key2 = Number(key >> 32n)
  const k1 = new Uint8Array([key1 & 0xff, (key1 >> 8) & 0xff, (key1 >> 16) & 0xff, (key1 >> 24) & 0xff])
  const k2 = new Uint8Array([key2 & 0xff, (key2 >> 8) & 0xff, (key2 >> 16) & 0xff, (key2 >> 24) & 0xff])
  const m = new Uint8Array(0x20)
  m[0x00] = k1[0]
  m[0x01] = k1[1]
  m[0x02] = k1[2]
  m[0x03] = k1[3] - 0x34
  m[0x04] = k2[0] + 0xF9
  m[0x05] = k2[1] ^ 0x13
  m[0x06] = k2[2] + 0x61
  m[0x07] = m[0x00] ^ 0xFF
  m[0x08] = m[0x02] + m[0x01]
  m[0x09] = m[0x01] - m[0x07]
  m[0x0A] = m[0x02] ^ 0xFF
  m[0x0B] = m[0x01] ^ 0xFF
  m[0x0C] = m[0x0B] + m[0x09]
  m[0x0D] = m[0x08] - m[0x03]
  m[0x0E] = m[0x0D] ^ 0xFF
  m[0x0F] = m[0x0A] - m[0x0B]
  m[0x10] = m[0x08] - m[0x0F]
  m[0x11] = m[0x10] ^ m[0x07]
  m[0x12] = m[0x0F] ^ 0xFF
  m[0x13] = m[0x03] ^ 0x10
  m[0x14] = m[0x04] - 0x32
  m[0x15] = m[0x05] + 0xED
  m[0x16] = m[0x06] ^ 0xF3
  m[0x17] = m[0x13] - m[0x0F]
  m[0x18] = m[0x15] + m[0x07]
  m[0x19] = 0x21 - m[0x13]
  m[0x1A] = m[0x14] ^ m[0x17]
  m[0x1B] = m[0x16] + m[0x16]
  m[0x1C] = m[0x17] + 0x44
  m[0x1D] = m[0x03] + m[0x04]
  m[0x1E] = m[0x05] - m[0x16]
  m[0x1F] = m[0x1D] ^ m[0x13]

  const mask2 = new Uint8Array(0x20)
  for (let i = 0; i < 0x20; i++)
    mask2[i] = m[i] ^ 0xFF
  return { mask1: m, mask2 }
}

/**
 * 音频掩码生成 (PyCriUsm fast_core.pyx UsmCrypter):
 *   偶数位 = mask1[i] ^ 0xFF (= video mask2[i])
 *   奇数位 = "URUC" 表 [0x55, 0x52, 0x55, 0x43][(i>>1)&3]
 * 与视频掩码共用同一 key, 但派生方式不同
 */
export function makeAudioMask(key: bigint): Uint8Array {
  const { mask1 } = makeVideoMask(key)
  const table2 = [0x55, 0x52, 0x55, 0x43] // "URUC"
  const audioMask = new Uint8Array(0x20)
  for (let i = 0; i < 0x20; i++) {
    audioMask[i] = (i & 1) ? table2[(i >> 1) & 3] : (mask1[i] ^ 0xFF)
  }
  return audioMask
}

/**
 * 音频数据解密 (PyCriUsm fast_core.pyx crypt_audio):
 *   简单 XOR (无反馈), 从 0x140 偏移开始
 *   小于等于 0x140 字节的块不解密 (原样保留)
 */
export function decryptAudio(data: Uint8Array, audioMask: Uint8Array): Uint8Array {
  const out = data.slice()
  if (out.length <= 0x140)
    return out
  for (let i = 0x140; i < out.length; i++)
    out[i] ^= audioMask[i & 0x1f]
  return out
}

/**
 * 视频数据反馈式解密 (与 PyCriUsm / GI MaskVideo 一致):
 *   mask 初始为 mask2, 从 0x40+0x100 起: data ^= mask[p]; mask[p] = data ^ mask2[p]
 *   然后 mask 换为 mask1, 前 0x100 字节: mask[p] ^= data[0x140+i]; data ^= mask[p]
 */
export function decryptVideo(data: Uint8Array, mask1: Uint8Array, mask2: Uint8Array): Uint8Array {
  const out = data.slice()
  const size = out.length - 0x40
  if (size < 0x200)
    return out

  const mask = new Uint8Array(mask2)
  for (let i = 0x100; i < size; i++) {
    const p = i & 0x1F
    out[0x40 + i] ^= mask[p]
    mask[p] = out[0x40 + i] ^ mask2[p]
  }
  const m1 = new Uint8Array(mask1)
  for (let i = 0; i < 0x100; i++) {
    const p = i & 0x1F
    m1[p] ^= out[0x140 + i]
    out[0x40 + i] ^= m1[p]
  }
  return out
}

/**
 * 从 USM 字节中提取 4.5 method2 (AES-CTR) 的 per-file nonce (8 字节)。
 *
 * nonce 存放在视频元数据表 VIDEO_HDRINFO (@UTF) 行数据的最后一列,
 * 紧贴字符串池 `<NULL>\0VIDEO_HDRINFO\0width...` 之前 — 直接搜索该标记读取。
 * 找不到返回 null (旧版/明文文件)。
 *
 * 每个版本文件的 nonce 各不相同, 必须从「正在播放的那份字节」里现读。
 */
export function findVideoNonce(usm: Uint8Array): Uint8Array | null {
  const marker = [0x3c, 0x4e, 0x55, 0x4c, 0x4c, 0x3e, 0x00, 0x56, 0x49, 0x44, 0x45, 0x4f, 0x5f, 0x48, 0x44, 0x52, 0x49, 0x4e, 0x46, 0x4f] // "<NULL>\0VIDEO_HDRINFO"
  const limit = Math.min(usm.length - marker.length, 0x10000)
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (usm[i + j] !== marker[j])
        continue outer
    }
    if (i < 8)
      return null
    return usm.slice(i - 8, i)
  }
  return null
}
