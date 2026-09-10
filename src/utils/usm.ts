let wasmInitPromise: Promise<void> | null = null

export async function initWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const mod = await import('@/assets/usm/usm_decoder.js')
      await mod.default()
    })()
  }
  return wasmInitPromise
}

export async function getUsmStreamDecoder(keyHex: string) {
  await initWasm()
  const { UsmStreamDecoder } = await import('@/assets/usm/usm_decoder.js')
  return new UsmStreamDecoder(keyHex)
}

export interface UsmAudioChannel {
  channel: number
  wav: Uint8Array
}

export interface DecodeUsmResult {
  videoWebm: Uint8Array
  audioChannels: UsmAudioChannel[]
}

export async function decodeUsm(data: Uint8Array, keyHex: string): Promise<DecodeUsmResult> {
  await initWasm()
  const { decode_usm } = await import('@/assets/usm/usm_decoder.js')
  const result = decode_usm(data, keyHex)
  return {
    videoWebm: result.video_webm as Uint8Array,
    audioChannels: (result.audio_channels ?? []) as UsmAudioChannel[],
  }
}

export async function decodeUsmToMkv(data: Uint8Array, keyHex: string, chIndex?: number | null): Promise<Uint8Array> {
  await initWasm()
  const { decode_usm_to_mkv } = await import('@/assets/usm/usm_decoder.js')
  return decode_usm_to_mkv(data, keyHex, chIndex ?? undefined) as Uint8Array
}

/** wasm decode_hca 封装: 输入拼装好的 HCA 流 + audioKey (16位hex), 输出 WAV 字节 */
export async function decodeHcaToWav(hcaBytes: Uint8Array, audioKeyHex: string): Promise<Uint8Array> {
  await initWasm()
  const { decode_hca } = await import('@/assets/usm/usm_decoder.js')
  const wav = decode_hca([hcaBytes], audioKeyHex) as Uint8Array
  if (!wav.length || wav[0] !== 0x52 || wav[1] !== 0x49)
    throw new Error('HCA 解码失败 (audioKey 可能不正确)')
  return wav
}

export interface WavPcm {
  pcm: Int16Array
  sampleRate: number
  channels: number
  totalSamples: number
}

/** 解析 wasm decode_hca 输出的 WAV (RIFF / 16bit PCM) → PCM */
export function parseWavPcm(wav: Uint8Array): WavPcm {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (wav.length < 44 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645)
    throw new Error('HCA 解码输出不是 WAV')
  let pos = 12
  let fmt: { channels: number, sampleRate: number, bits: number } | null = null
  let dataOff = -1
  let dataLen = 0
  while (pos + 8 <= wav.length) {
    const id = dv.getUint32(pos, false)
    const size = dv.getUint32(pos + 4, true)
    if (id === 0x666D7420)
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
