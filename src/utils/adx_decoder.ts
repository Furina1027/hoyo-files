/**
 * CRI ADX ADPCM 解码器 — 纯 JS 实现
 *
 * 与 FFmpeg libavcodec/adxdec.c 算法完全对齐:
 *   - scale = AV_RB16(block) (全 16 位; scale & 0x8000 = EOF 标记)
 *   - 32 个 4-bit 有符号 nibble (MSB first)
 *   - s0 = d * scale + (coeff0 * s1 + coeff1 * s2) >> 12
 *   - 系数由 cutoff 频率经 ff_adx_calculate_coeffs 公式计算
 *
 * 崩铁 USM 的 @SFA 音频块为 ADX 格式 (非 HCA), 需本解码器处理
 */

export interface AdxDecodeResult {
  /** 交错 PCM (Int16, L/R/L/R...), 与 Web Audio API createBuffer 兼容 */
  pcm: Int16Array
  sampleRate: number
  channels: number
  totalSamples: number // 每声道样本数
}

/** FFmpeg ff_adx_calculate_coeffs: 从 cutoff 频率计算 LPC 系数 */
function calcCoeffs(cutoff: number, sampleRate: number): [number, number] {
  const a = Math.SQRT2 - Math.cos(2 * Math.PI * cutoff / sampleRate)
  const b = Math.SQRT2 - 1.0
  const c = (a - Math.sqrt((a + b) * (a - b))) / b
  return [Math.round(c * 2.0 * 4096), Math.round(-(c * c) * 4096)]
}

/**
 * 解码完整 ADX 流 → 交错 PCM
 *
 * @param adx ADX 字节流 (含 header + audio data)
 * @returns 解码结果
 */
export function decodeAdx(adx: Uint8Array): AdxDecodeResult {
  if (adx.length < 18 || adx[0] !== 0x80 || adx[1] !== 0x00)
    throw new Error('不是有效 ADX 文件')

  const dataOffset = (adx[2] << 8) | adx[3] // header 中的 data_offset 字段
  const headerSize = dataOffset + 4 // FFmpeg: header_size = offset + 4 (含 copyright)
  const channels = adx[7]
  const sampleRate = (adx[8] << 24) | (adx[9] << 16) | (adx[10] << 8) | adx[11]
  const cutoff = (adx[16] << 8) | adx[17]

  if (!channels || !sampleRate)
    throw new Error('ADX header 无效')

  const [coeff0, coeff1] = calcCoeffs(cutoff, sampleRate)

  const blockSize = 18
  const blockSamples = 32
  const frameSize = blockSize * channels
  const audioStart = headerSize
  const numFrames = Math.floor((adx.length - audioStart) / frameSize)
  const totalSamples = numFrames * blockSamples

  // Planar 解码: [ch0 全部样本][ch1 全部样本]...
  const planar = new Int16Array(channels * totalSamples)
  const hist: [number, number][] = Array.from({ length: channels }, () => [0, 0])

  for (let f = 0; f < numFrames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const blockOff = audioStart + f * frameSize + ch * blockSize
      if (blockOff + blockSize > adx.length)
        break

      const scale = (adx[blockOff] << 8) | adx[blockOff + 1]
      if (scale & 0x8000) {
        // EOF marker — 停止解码此通道
        return interleave(planar, channels, totalSamples, sampleRate, f * blockSamples)
      }

      let s1 = hist[ch][0]
      let s2 = hist[ch][1]
      for (let i = 0; i < blockSamples; i++) {
        const byteIdx = blockOff + 2 + (i >> 1)
        let d = (adx[byteIdx] >> ((i & 1) ? 0 : 4)) & 0x0F
        if (d & 8)
          d -= 16

        const s0 = d * scale + ((coeff0 * s1 + coeff1 * s2) >> 12)
        const clipped = Math.max(-32768, Math.min(32767, s0))
        s2 = s1
        s1 = clipped
        planar[ch * totalSamples + f * blockSamples + i] = clipped
      }
      hist[ch][0] = s1
      hist[ch][1] = s2
    }
  }

  return interleave(planar, channels, totalSamples, sampleRate, totalSamples)
}

/** Planar → Interleaved 转换 */
function interleave(planar: Int16Array, channels: number, totalSamples: number, sampleRate: number, actualSamples: number): AdxDecodeResult {
  const interleaved = new Int16Array(channels * actualSamples)
  for (let i = 0; i < actualSamples; i++) {
    for (let ch = 0; ch < channels; ch++)
      interleaved[i * channels + ch] = planar[ch * totalSamples + i]
  }
  return { pcm: interleaved, sampleRate, channels, totalSamples: actualSamples }
}

/**
 * 从 USM 字节流提取指定 chno 的 ADX 音频流
 *
 * @param usm 完整 USM 字节
 * @param chno 音频通道号 (0=第一语言, 1=第二语言, ...)
 * @param keyHex 16 位 hex key (全零=不加密)
 * @param decrypt 是否应用 ADX mask；HCA 原始流必须传 false
 * @returns ADX 字节流 (可直接传给 decodeAdx)
 */
export async function extractAdxFromUsm(usm: Uint8Array, chno: number, keyHex: string, decrypt = true): Promise<Uint8Array> {
  const { parseUsmChunks, makeAudioMask, decryptAudio } = await import('./usm_demux.ts')

  const chunks = parseUsmChunks(usm)
    .filter(c => c.type === '@SFA' && c.chno === chno)
    .map(c => c.data)

  if (chunks.length === 0)
    throw new Error(`未找到 chno=${chno} 的 @SFA 音频块`)

  // 加密时解密音频 (非零 key)
  const needDecrypt = decrypt && keyHex && keyHex !== '0000000000000000'
  const audioMask = needDecrypt ? makeAudioMask(BigInt(`0x${keyHex}`)) : null

  const processed = audioMask
    ? chunks.map(c => decryptAudio(c, audioMask))
    : chunks

  const total = processed.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of processed) {
    out.set(p, off)
    off += p.length
  }
  return out
}
