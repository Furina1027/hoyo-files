<script setup lang="ts">
import type { ChunkManifest, ParsedChunk } from '@/types'
import type { UsmKeyEntry } from '@/utils/usm_demux'
import { API_BASE, AUDIO_LANG_LABELS, GameList } from '@/constants/core'
import { useSettings } from '@/store/settings'
import { decodeAdx, extractAdxFromUsm } from '@/utils/adx_decoder'
import { downloadChunks } from '@/utils/chunk'
import { fetchAndParseManifest } from '@/utils/manifest'
import { decodeHcaToWav, getUsmStreamDecoder, parseWavPcm } from '@/utils/usm'
import { parseUsmChunks } from '@/utils/usm_demux'

interface Props {
  filename: string
  keyEntry: UsmKeyEntry
  directDownloadUrl: string | null
  bestChunkVersion: string | null
  gameId: string
  filePath: string
  /**
   * 本地游戏目录里已确认存在该文件（官方 CDN 已下架的情况）。
   * 此时 directDownloadUrl / bestChunkVersion 都会是 null，
   * 但服务器仍可从本地游戏文件取字节，仍需做一次格式探测以选对播放通路。
   */
  localAvailable?: boolean
  /** 后端静默使用历史同源文件时，仍由前端保留原文件名显示。 */
  serverAlias?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: [] }>()

/** 从 localStorage 读取用户设置的游戏安装路径 */
function getGameDir(gameId: string): string | null {
  try {
    return localStorage.getItem(`game_dir_${gameId}`) || null
  }
  catch {
    return null
  }
}

const videoRef = ref<HTMLVideoElement | null>(null)
const phase = ref<'init' | 'buffering' | 'playing' | 'error'>('init')
const errorMsg = ref('')
const progress = ref(0)
const showHelp = ref(false)
const progressLabel = ref('')

const audioChannelList = ref<number[]>([])
const currentChannel = ref(0)
const audioStatusText = ref('')

let abortController: AbortController | null = null
let mediaSource: MediaSource | null = null
let objectUrl: string | null = null

let audioCtx: AudioContext | null = null
let gainNode: GainNode | null = null
let audioBuffer: AudioBuffer | null = null
let audioSource: AudioBufferSourceNode | null = null

/** 掩码 key (4.4 字符串条目); 4.5 method2 对象条目的音频不走掩码 → 传全零 */
const maskKeyHex = typeof props.keyEntry === 'string' ? props.keyEntry : '0000000000000000'
/** 4.5 method2 的 HCA 音频 keycode (对象条目才有) */
// 67_test 的 key 条目只负责让历史列表显示可播放；音频沿用历史 67 的旧 key。
const hcaAudioKeyHex = (typeof props.keyEntry === 'object' && props.keyEntry?.audio)
  ? props.keyEntry.audio
  : props.serverAlias ? maskKeyHex : ''

const settings = useSettings()

const audioVolume = computed({
  get: () => settings.usmPlayerVolume,
  set: (val: number) => { settings.usmPlayerVolume = val },
})

function getChannelLabel(ch: number): string {
  const langs = GameList.find(g => g.id === props.gameId)?.audioLangs ?? []
  return AUDIO_LANG_LABELS[langs[ch] ?? ''] ?? `通道 ${ch}`
}
watch(audioVolume, (val) => {
  if (gainNode)
    gainNode.gain.value = val
})

let hasAutoSwitched = false
watch(audioChannelList, (channels) => {
  if (hasAutoSwitched || channels.length === 0)
    return
  const langs = GameList.find(g => g.id === props.gameId)?.audioLangs ?? []
  const prefIdx = langs.indexOf(settings.usmDefaultAudioLang)
  if (prefIdx >= 0 && channels.includes(prefIdx)) {
    switchChannel(prefIdx)
    hasAutoSwitched = true
  }
}, { deep: true })

const audioPcmByChannel = new Map<number, any[]>()
const adxAudioBuffers = new Map<number, AudioBuffer>()
let streamAudioNodes: AudioBufferSourceNode[] = []
let streamAudioActive = false
let streamAudioReady = false
let audioTimeBase = 0
let pendingPcmChunks: Array<{ chunk: any, idx: number }> = []

let videoAudioSyncCleanup: (() => void) | null = null

const SAMPLES_PER_CHUNK = 1024
const mimeType = 'video/webm; codecs="vp9"'
const MAX_SOURCE_BUFFER_QUEUE_BYTES = 16 * 1024 * 1024
const MAX_BUFFER_AHEAD_SECONDS = 18
const MAX_PAUSED_BUFFER_AHEAD_SECONDS = 45

function makeSourceBufferQueue(sb: SourceBuffer, video: HTMLVideoElement) {
  const queue: Uint8Array[] = []
  const stateWaiters: Array<() => void> = []
  let queuedBytes = 0
  let activeOp: 'append' | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let fatalError: Error | null = null

  function notifyStateChange() {
    while (stateWaiters.length)
      stateWaiters.shift()?.()
  }

  function scheduleRetry() {
    if (retryTimer !== null)
      return
    retryTimer = setTimeout(() => {
      retryTimer = null
      notifyStateChange()
      drain()
    }, 50)
  }

  function getBufferedAhead() {
    const currentTime = video.currentTime
    const { buffered } = sb

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i)
      const end = buffered.end(i)

      if (end <= currentTime)
        continue
      if (start <= currentTime + 0.1)
        return end - currentTime
      return end - start
    }

    return 0
  }

  function drain() {
    if (fatalError || activeOp !== null || sb.updating)
      return

    if (!queue.length) {
      notifyStateChange()
      return
    }

    activeOp = 'append'

    try {
      sb.appendBuffer(queue[0] as BufferSource)
    }
    catch (error) {
      activeOp = null

      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        scheduleRetry()
        return
      }

      fatalError = error instanceof Error ? error : new Error(String(error))
      notifyStateChange()
    }
  }

  sb.addEventListener('updateend', () => {
    if (activeOp === 'append') {
      const appended = queue.shift()
      if (appended)
        queuedBytes -= appended.byteLength
    }
    activeOp = null
    notifyStateChange()
    drain()
  })

  async function waitForStateChange(signal: AbortSignal) {
    if (signal.aborted)
      return

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      let onStateChange: () => void
      let onAbort: () => void

      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const index = stateWaiters.indexOf(onStateChange)
        if (index >= 0)
          stateWaiters.splice(index, 1)
      }
      onStateChange = () => {
        cleanup()
        resolve()
      }
      onAbort = () => {
        cleanup()
        resolve()
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 120)

      stateWaiters.push(onStateChange)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    append(data: Uint8Array) {
      if (fatalError)
        throw fatalError

      const copy = data.slice()
      queue.push(copy)
      queuedBytes += copy.byteLength
      drain()
    },
    async waitForCapacity(signal: AbortSignal) {
      while (!signal.aborted) {
        if (fatalError)
          throw fatalError

        const maxBufferedAhead = video.paused ? MAX_PAUSED_BUFFER_AHEAD_SECONDS : MAX_BUFFER_AHEAD_SECONDS
        if (queuedBytes <= MAX_SOURCE_BUFFER_QUEUE_BYTES && getBufferedAhead() < maxBufferedAhead)
          return

        await waitForStateChange(signal)
      }
    },
    async waitDrained(signal: AbortSignal) {
      while (!signal.aborted) {
        if (fatalError)
          throw fatalError
        if (activeOp === null && !sb.updating && queue.length === 0 && retryTimer === null)
          return

        await waitForStateChange(signal)
      }
    },
  }
}

function scheduleOnePcmChunk(chunk: any, idx: number) {
  if (!audioCtx)
    return
  const sr: number = chunk.sample_rate
  const nc: number = chunk.channel_count
  const t = audioTimeBase + idx * SAMPLES_PER_CHUNK / sr
  if (t + SAMPLES_PER_CHUNK / sr < audioCtx.currentTime - 0.05)
    return
  const abuf = audioCtx.createBuffer(nc, SAMPLES_PER_CHUNK, sr)
  const i16 = new Int16Array(chunk.pcm_i16_bytes.buffer, chunk.pcm_i16_bytes.byteOffset, chunk.pcm_i16_bytes.byteLength / 2)
  for (let ch = 0; ch < nc; ch++) {
    const d = abuf.getChannelData(ch)
    for (let i = 0; i < SAMPLES_PER_CHUNK; i++)
      d[i] = i16[i * nc + ch] / 32768.0
  }
  const src = audioCtx.createBufferSource()
  src.buffer = abuf
  src.connect(gainNode ?? audioCtx.destination)
  src.start(Math.max(t, audioCtx.currentTime))
  streamAudioNodes.push(src)
}

function stopAllStreamNodes() {
  for (const node of streamAudioNodes) {
    try {
      node.stop(0)
    }
    catch {}
    node.disconnect()
  }
  streamAudioNodes.length = 0
}

function rescheduleStreamAudio() {
  if (!streamAudioActive || !streamAudioReady || !videoRef.value || !audioCtx)
    return
  stopAllStreamNodes()
  audioTimeBase = audioCtx.currentTime - videoRef.value.currentTime
  const vt = videoRef.value.currentTime
  const chunks = audioPcmByChannel.get(currentChannel.value) ?? []
  for (let i = 0; i < chunks.length; i++) {
    const sr: number = chunks[i].sample_rate
    if ((i + 1) * SAMPLES_PER_CHUNK / sr >= vt - 0.05)
      scheduleOnePcmChunk(chunks[i], i)
  }
}

function feedAudioChunk(chunk: any) {
  const chNo: number = chunk.channel
  if (!audioPcmByChannel.has(chNo)) {
    audioPcmByChannel.set(chNo, [])
    if (!audioChannelList.value.includes(chNo))
      audioChannelList.value.push(chNo)
  }
  const chChunks = audioPcmByChannel.get(chNo)!
  const idx = chChunks.length
  chChunks.push(chunk)
  if (chNo !== currentChannel.value)
    return
  if (streamAudioReady)
    scheduleOnePcmChunk(chunk, idx)
  else
    pendingPcmChunks.push({ chunk, idx })
}

function onStreamVideoPlaying() {
  if (!streamAudioActive || streamAudioReady || !audioCtx || !videoRef.value)
    return
  streamAudioReady = true
  audioTimeBase = audioCtx.currentTime - videoRef.value.currentTime
  audioStatusText.value = ''
  for (const { chunk, idx } of pendingPcmChunks)
    scheduleOnePcmChunk(chunk, idx)
  pendingPcmChunks.length = 0
}

function stopAudio() {
  if (audioSource) {
    try {
      audioSource.stop()
    }
    catch {}
    audioSource.disconnect()
    audioSource = null
  }
}

function startAudio(offsetSec: number) {
  if (!audioBuffer || !audioCtx)
    return
  if (audioCtx.state === 'suspended')
    audioCtx.resume()
  stopAudio()
  audioSource = audioCtx.createBufferSource()
  audioSource.buffer = audioBuffer
  audioSource.connect(gainNode ?? audioCtx.destination)
  audioSource.start(0, Math.max(0, offsetSec))
}

function bindVideoAudioSync(video: HTMLVideoElement) {
  if (videoAudioSyncCleanup)
    videoAudioSyncCleanup()
  const onPlay = () => {
    if (audioBuffer)
      startAudio(video.currentTime)
  }
  const onPause = () => stopAudio()
  const onSeeked = () => {
    if (audioBuffer && !video.paused)
      startAudio(video.currentTime)
  }
  const onEnded = () => stopAudio()
  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  video.addEventListener('seeked', onSeeked)
  video.addEventListener('ended', onEnded)
  videoAudioSyncCleanup = () => {
    video.removeEventListener('play', onPlay)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('seeked', onSeeked)
    video.removeEventListener('ended', onEnded)
  }
}

function buildAudioBuffer(chNo: number): AudioBuffer | null {
  if (!audioCtx)
    return null
  const chunks = audioPcmByChannel.get(chNo)
  if (!chunks || chunks.length === 0)
    return null
  const sr: number = chunks[0].sample_rate
  const nc: number = chunks[0].channel_count
  const totalFrames = chunks.length * SAMPLES_PER_CHUNK
  try {
    const buf = audioCtx.createBuffer(nc, totalFrames, sr)
    let frameOffset = 0
    for (const chunk of chunks) {
      const i16 = new Int16Array(chunk.pcm_i16_bytes.buffer, chunk.pcm_i16_bytes.byteOffset, chunk.pcm_i16_bytes.byteLength / 2)
      for (let ch = 0; ch < nc; ch++) {
        const channelData = buf.getChannelData(ch)
        for (let i = 0; i < SAMPLES_PER_CHUNK; i++)
          channelData[frameOffset + i] = i16[i * nc + ch] / 32768.0
      }
      frameOffset += SAMPLES_PER_CHUNK
    }
    return buf
  }
  catch (e) {
    console.error('buildAudioBuffer:', e)
    return null
  }
}

function switchChannel(chNo: number) {
  currentChannel.value = chNo
  if (streamAudioActive) {
    if (!streamAudioReady) {
      pendingPcmChunks.length = 0
      const newChunks = audioPcmByChannel.get(chNo) ?? []
      for (let i = 0; i < newChunks.length; i++)
        pendingPcmChunks.push({ chunk: newChunks[i], idx: i })
    }
    else {
      rescheduleStreamAudio()
      if (videoRef.value?.paused)
        audioCtx?.suspend()
    }
    return
  }
  // ADX 音频 (崩铁): 优先使用预解码的 AudioBuffer
  const adxBuf = adxAudioBuffers.get(chNo)
  if (adxBuf) {
    audioBuffer = adxBuf
    if (videoRef.value) {
      bindVideoAudioSync(videoRef.value)
      if (!videoRef.value.paused)
        startAudio(videoRef.value.currentTime)
    }
    audioStatusText.value = `音频通道 ${chNo}（${adxBuf.numberOfChannels}ch · ${adxBuf.sampleRate} Hz · ${adxBuf.duration.toFixed(1)}s）`
    return
  }
  audioStatusText.value = '音频通道切换中'
  const buf = buildAudioBuffer(chNo)
  if (buf) {
    audioBuffer = buf
    if (videoRef.value && !videoRef.value.paused)
      startAudio(videoRef.value.currentTime)
    const { numberOfChannels, sampleRate, duration } = buf
    audioStatusText.value = `音频通道 ${chNo}（${numberOfChannels}ch · ${sampleRate} Hz · ${duration.toFixed(1)}s）`
  }
}

/** 累积 VP9 流式播放时的 USM 原始字节 (用于 ADX 音频提取) */
let accumulatedUsmBytes: Uint8Array[] = []

/** 取指定 chno 第一个 @SFA 数据块头部 (ADX `80 00` / HCA 最高位混淆 magic 判别用) */
function firstAudioChunkHead(usmBytes: Uint8Array, chno: number): Uint8Array {
  for (const c of parseUsmChunks(usmBytes)) {
    if (c.type === '@SFA' && c.chno === chno && c.data.length >= 2)
      return c.data
  }
  return new Uint8Array(0)
}

/**
 * 从 USM 字节加载音频 (崩铁专用)
 * 对每个 chno 提取 @SFA 块 → ADX(掩码/明文) 或 HCA(audioKey) 解码 → AudioBuffer
 */
async function loadAdxAudio(usmBytes: Uint8Array, signal: AbortSignal) {
  if (signal.aborted)
    return

  const langs = GameList.find(g => g.id === props.gameId)?.audioLangs ?? []
  const numChannels = langs.length || 4

  if (!audioCtx) {
    audioCtx = new AudioContext()
    gainNode = audioCtx.createGain()
    gainNode.gain.value = audioVolume.value
    gainNode.connect(audioCtx.destination)
  }

  for (let chno = 0; chno < numChannels; chno++) {
    if (signal.aborted)
      return
    try {
      let pcm: Int16Array
      let sampleRate: number
      let channels: number
      // 4.5 method2 剧情视频的 @SFA 是 HCA (magic 最高位混淆), 其余为 ADX
      const head = firstAudioChunkHead(usmBytes, chno)
      const isHca = head.length > 1 && (head[0] & 0x7F) === 0x48 && (head[1] & 0x7F) === 0x43
      if (isHca) {
        if (!hcaAudioKeyHex)
          throw new Error('缺少 audioKey')
        // HCA 不经过 ADX mask；历史 67 直接把原始 HCA 字节交给 HCA 解码器。
        const hca = await extractAdxFromUsm(usmBytes, chno, '', false)
        const wav = await decodeHcaToWav(hca, hcaAudioKeyHex)
        ;({ pcm, sampleRate, channels } = parseWavPcm(wav))
      }
      else {
        const adx = await extractAdxFromUsm(usmBytes, chno, maskKeyHex)
        ;({ pcm, sampleRate, channels } = decodeAdx(adx))
      }
      const totalSamples = pcm.length / channels
      const buf = audioCtx.createBuffer(channels, totalSamples, sampleRate)
      for (let ch = 0; ch < channels; ch++) {
        const data = buf.getChannelData(ch)
        for (let i = 0; i < totalSamples; i++)
          data[i] = pcm[i * channels + ch] / 32768.0
      }
      adxAudioBuffers.set(chno, buf)
      if (!audioChannelList.value.includes(chno))
        audioChannelList.value.push(chno)
    }
    catch {
      // 某些 chno 可能不存在, 忽略
    }
  }

  if (signal.aborted || adxAudioBuffers.size === 0)
    return

  // 自动选择偏好语言通道
  if (!hasAutoSwitched) {
    const prefIdx = langs.indexOf(settings.usmDefaultAudioLang)
    const targetCh = prefIdx >= 0 && adxAudioBuffers.has(prefIdx) ? prefIdx : 0
    if (adxAudioBuffers.has(targetCh)) {
      switchChannel(targetCh)
      hasAutoSwitched = true
    }
  }
  else if (adxAudioBuffers.has(currentChannel.value)) {
    // 已切换过, 重新绑定
    switchChannel(currentChannel.value)
  }
}

/** 获取完整 USM 字节 (通过服务器代理) */
async function fetchUsmBytes(signal: AbortSignal): Promise<Uint8Array> {
  const params = new URLSearchParams()
  params.set('game', props.gameId)
  params.set('file', props.filePath)
  const gameDir = getGameDir(props.gameId)
  if (gameDir)
    params.set('game_dir', gameDir)
  if (props.directDownloadUrl)
    params.set('url', props.directDownloadUrl)
  if (props.bestChunkVersion)
    params.set('version', props.bestChunkVersion)
  const res = await fetch(`${API_BASE}/api/usm-proxy?${params}`, { signal })
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function startStreaming() {
  if (!videoRef.value)
    return

  // controller 必须覆盖整个生命周期, 含格式探测阶段。原来它在下面三个播放
  // 函数里各建一个, 于是探测期间 abortController 还是 null —— 那时点关闭
  // (handleClose) 或组件卸载 (onUnmounted) 的 abort() 落空, 探测请求继续跑,
  // 探测完还会继续往下走, 对已卸载的 video 赋值并发起新的 fetch。
  abortController = new AbortController()
  const { signal } = abortController

  // 探测视频格式: H.264 与 MPEG1(4.5 TV 类, 服务器 ffmpeg 转码) 走整体 MP4 播放; VP9 走流式
  try {
    const fmt = await probeVideoFormat(signal)
    if (signal.aborted)
      return
    if (fmt === 'h264' || fmt === 'mpeg1') {
      await playH264(signal)
      return
    }
    if (fmt === 'vp9' && props.gameId === 'hk4e' && (typeof props.keyEntry === 'object' || props.serverAlias)) {
      await playServerVp9(signal)
      return
    }
  }
  catch {
    // 探测失败回退 VP9 流式; 已中止则不再继续
    if (signal.aborted)
      return
  }
  if (signal.aborted)
    return
  await startStreamingVP9(signal)
}

/** 探测 USM 视频格式 (检查流 chunk 数据 magic) */
function detectVideoFormat(buf: Uint8Array): 'vp9' | 'h264' | 'mpeg1' | null {
  let checked = 0
  for (const c of parseUsmChunks(buf)) {
    if (c.data.length < 8)
      continue
    const d = c.data
    if (d[0] === 0x44 && d[1] === 0x4B && d[2] === 0x49 && d[3] === 0x46)
      return 'vp9' // DKIF (IVF)
    if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1)
      return 'h264' // 00000001 (Annex-B)
    if (d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0xB3)
      return 'mpeg1' // 000001B3 (MPEG-1 ES)
    if (++checked >= 4)
      break
  }
  return null
}

async function probeVideoFormat(signal: AbortSignal): Promise<'vp9' | 'h264' | 'mpeg1' | null> {
  // 通过数据服务器探测 (服务器无浏览器网络/大响应限制; 加密文件用 key 解密后判断;
  // 本地游戏文件优先, 直链失败自动回退 chunk)
  if (props.directDownloadUrl || props.bestChunkVersion || props.localAvailable) {
    try {
      const params = new URLSearchParams({ game: props.gameId, file: props.filePath })
      const gameDir = getGameDir(props.gameId)
      if (gameDir)
        params.set('game_dir', gameDir)
      if (props.directDownloadUrl)
        params.set('url', props.directDownloadUrl)
      if (props.bestChunkVersion)
        params.set('version', props.bestChunkVersion)
      const res = await fetch(`${API_BASE}/api/usm-detect?${params}`, { signal })
      if (res.ok) {
        const data = await res.json() as { format?: string }
        if (data.format === 'vp9' || data.format === 'h264')
          return data.format
      }
    }
    catch { /* 回退 */ }
  }
  // chunk 路径: 下载第一个 chunk 解压后探测
  if (props.bestChunkVersion) {
    const firstChunk = await fetchFirstChunk(signal)
    if (firstChunk) {
      const fmt = detectVideoFormat(firstChunk)
      if (fmt)
        return fmt
    }
  }
  return null
}

async function fetchFirstChunk(signal: AbortSignal): Promise<Uint8Array | null> {
  const res = await fetch(`${API_BASE}/chunk/${props.gameId}_${props.bestChunkVersion}.json`, { signal })
  if (!res.ok)
    return null
  const json = await res.json()
  const manifests: ChunkManifest[] = json.data?.manifests ?? []
  for (const m of manifests) {
    if (signal.aborted)
      return null
    const cacheKey = `${props.gameId}_${props.bestChunkVersion}_${m.manifest.id}`
    const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
    let parsed
    try {
      parsed = await fetchAndParseManifest(url, cacheKey, Number(m.manifest.uncompressed_size), signal)
    }
    catch {
      continue
    }
    const match = parsed.files.find(f => f.path === props.filePath)
    if (match && match.chunks.length) {
      const c = match.chunks[0]
      const r = await fetch(`${m.chunk_download.url_prefix}/${c.id}`, { signal })
      if (!r.ok)
        return null
      const compressed = new Uint8Array(await r.arrayBuffer())
      // chunk 是 zstd 压缩的, 先解压再探测
      const { ZSTDDecoder } = await import('zstddec')
      const dec = new ZSTDDecoder()
      await dec.init()
      return dec.decode(compressed, Number(c.uncompressedSize))
    }
  }
  return null
}

async function playServerVp9(signal: AbortSignal) {
  if (!videoRef.value)
    return
  phase.value = 'buffering'
  progress.value = 0
  progressLabel.value = '服务器解密 VP9...'
  audioStatusText.value = ''
  audioChannelList.value = []
  try {
    const params = new URLSearchParams()
    params.set('game', props.gameId)
    params.set('file', props.filePath)
    const gameDir = getGameDir(props.gameId)
    if (gameDir)
      params.set('game_dir', gameDir)
    if (props.directDownloadUrl)
      params.set('url', props.directDownloadUrl)
    if (props.bestChunkVersion)
      params.set('version', props.bestChunkVersion)
    params.set('audio', '0')
    const res = await fetch(`${API_BASE}/api/usm-webm?${params}`, { signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text.replace(/^USM 转换失败:\s*/, '') || `HTTP ${res.status}`)
    }
    const total = Number(res.headers.get('Content-Length') ?? 0)
    const reader = res.body!.getReader()
    const parts: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (signal.aborted)
        return
      parts.push(value)
      received += value.byteLength
      if (total > 0)
        progress.value = Math.min(99, Math.round((received / total) * 99))
    }
    objectUrl = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/webm' }))
    videoRef.value.src = objectUrl
    await videoRef.value.play().catch(() => {})
    try {
      audioStatusText.value = '四音轨加载中...'
      const usmBytes = await fetchUsmBytes(signal)
      if (signal.aborted)
        return
      await loadAdxAudio(usmBytes, signal)
      if (signal.aborted)
        return
      if (audioChannelList.value.length === 0)
        audioStatusText.value = '未找到可用音轨'
      else if (audioStatusText.value === '四音轨加载中...')
        audioStatusText.value = `已加载 ${audioChannelList.value.length} 条音轨`
    }
    catch (e) {
      if ((e as Error).name === 'AbortError')
        return
      audioStatusText.value = '音频加载失败'
    }
    phase.value = 'playing'
    progress.value = 100
    progressLabel.value = '加载完成'
  }
  catch (e) {
    if ((e as Error).name === 'AbortError')
      return
    phase.value = 'error'
    errorMsg.value = (e as Error).message || String(e)
  }
}

/** H.264 路径: 服务器转 MP4 → 浏览器 fetch 下载 (带进度) → Blob URL 播放 (避开 video 直连加载的卡顿) */
async function playH264(signal: AbortSignal) {
  if (!videoRef.value)
    return
  phase.value = 'buffering'
  progress.value = 0
  progressLabel.value = '服务器转换中...'
  audioStatusText.value = ''
  audioChannelList.value = []

  try {
    // 服务器转换端点: 带 game+file (查 key 解密) + version (直链失效时回退 chunk 组装)
    const params = new URLSearchParams()
    params.set('game', props.gameId)
    params.set('file', props.filePath)
    const gameDir = getGameDir(props.gameId)
    if (gameDir)
      params.set('game_dir', gameDir)
    if (props.directDownloadUrl)
      params.set('url', props.directDownloadUrl)
    if (props.bestChunkVersion)
      params.set('version', props.bestChunkVersion)
    const mp4Url = `${API_BASE}/api/usm-mp4?${params}`

    const res = await fetch(mp4Url, { signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text.replace(/^USM 转换失败:\s*/, '') || `HTTP ${res.status}`)
    }

    // 流式下载 (真实进度), 完成后用 Blob URL 播放
    const total = Number(res.headers.get('Content-Length') ?? 0)
    progressLabel.value = '下载转换结果...'
    const reader = res.body!.getReader()
    const parts: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (signal.aborted)
        return
      parts.push(value)
      received += value.byteLength
      if (total > 0) {
        progress.value = Math.min(99, Math.round((received / total) * 99))
        progressLabel.value = `${formatBytes(received)} / ${formatBytes(total)}`
      }
      else {
        progressLabel.value = `已接收 ${formatBytes(received)}`
      }
    }

    objectUrl = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/mp4' }))
    videoRef.value.src = objectUrl
    await videoRef.value.play().catch(() => {})

    phase.value = 'playing'
    progress.value = 100
    progressLabel.value = '加载完成'

    // 崩铁 H.264 路径: 视频已播放, 后台加载 ADX 音频
    if (props.gameId === 'hkrpg') {
      audioStatusText.value = '加载音频中...'
      try {
        const usmBytes = await fetchUsmBytes(signal)
        if (signal.aborted)
          return
        await loadAdxAudio(usmBytes, signal)
      }
      catch (e) {
        if ((e as Error).name !== 'AbortError')
          audioStatusText.value = '音频加载失败'
      }
    }
  }
  catch (e) {
    if ((e as Error).name === 'AbortError')
      return
    phase.value = 'error'
    errorMsg.value = (e as Error).message || String(e)
  }
}

async function startStreamingVP9(signal: AbortSignal) {
  if (!videoRef.value)
    return

  if (!MediaSource.isTypeSupported(mimeType)) {
    phase.value = 'error'
    errorMsg.value = '当前浏览器不支持 WebM VP9 流式播放（建议使用 Chrome/Edge）'
    return
  }

  audioCtx = new AudioContext()
  gainNode = audioCtx.createGain()
  gainNode.gain.value = audioVolume.value
  gainNode.connect(audioCtx.destination)
  streamAudioActive = true
  streamAudioReady = false
  audioPcmByChannel.clear()
  adxAudioBuffers.clear()
  accumulatedUsmBytes = []
  streamAudioNodes = []
  pendingPcmChunks = []
  audioChannelList.value = []
  currentChannel.value = 0
  audioStatusText.value = ''
  hasAutoSwitched = false

  if (signal.aborted)
    return

  mediaSource = new MediaSource()
  objectUrl = URL.createObjectURL(mediaSource)
  videoRef.value.src = objectUrl

  await new Promise<void>((resolve, reject) => {
    mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true })
    mediaSource!.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true })
  })

  const sb = mediaSource.addSourceBuffer(mimeType)
  const sbQueue = makeSourceBufferQueue(sb, videoRef.value)

  phase.value = 'buffering'
  progress.value = 0

  const onStreamPause = () => {
    if (streamAudioActive)
      audioCtx?.suspend()
  }
  const onStreamPlay = () => {
    if (streamAudioActive)
      audioCtx?.resume()
  }
  const onStreamSeeked = () => {
    if (!streamAudioActive)
      return
    rescheduleStreamAudio()
    if (videoRef.value?.paused)
      audioCtx?.suspend()
  }

  videoRef.value.addEventListener('playing', onStreamVideoPlaying, { once: true })
  videoRef.value.addEventListener('pause', onStreamPause)
  videoRef.value.addEventListener('play', onStreamPlay)
  videoRef.value.addEventListener('seeked', onStreamSeeked)

  try {
    const dec = await getUsmStreamDecoder(maskKeyHex)

    // dec 持有 wasm 线性内存 (VP9 参考帧 + 缓冲), 只有 free() 能还回去。
    // 原来 free() 只写在成功路径上, 于是「中途点关闭」(:920 的 signal.aborted
    // 早退) 和「streamDirect/streamChunks/dec.push 抛错」这两条出口都漏一个
    // 实例 —— 而播放/关弹窗是本组件最高频的操作, 漏得比导出那条快得多。
    // getUsmStreamDecoder 每次都 new、不共享, 所以这里独占释放安全。
    try {
      // 始终优先走服务器代理 (usm-proxy 内含 本地游戏文件 → 直链 → chunk 组装 三级回退;
      // 浏览器直连 chunk 会绕过本地回退, 导致 Persistent 热更副本失效)
      try {
        await streamDirect(dec, sbQueue, signal)
      }
      catch (e) {
        const msg = typeof e === 'string' ? e : ((e as Error)?.message ?? String(e))
        // 仅"流未开始"的失败才回退浏览器 chunk; 流中途失败直接抛出(避免重复推流)
        if (!props.bestChunkVersion || !(e as any)?.preStream)
          throw e
        console.warn(`[usm] 代理流失败 (${msg}), 回退浏览器 chunk 下载`)
        await streamChunks(props.bestChunkVersion, dec, sbQueue, signal)
      }

      if (signal.aborted)
        return

      const finalResult = dec.finish()
      for (const c of finalResult.clusters as Uint8Array[])
        sbQueue.append(c)
      for (const chunk of (finalResult.audio_pcm_chunks ?? []))
        feedAudioChunk(chunk)
    }
    finally {
      // 紧贴最后一次使用dec 的位置释放: 下面 waitDrained / 音频收尾只用到
      // 已 append 进 sbQueue 的 Uint8Array, 不再碰 dec。
      dec.free()
    }

    await sbQueue.waitDrained(signal)

    if (!signal.aborted && mediaSource.readyState === 'open') {
      mediaSource.endOfStream()
    }

    streamAudioActive = false
    videoRef.value?.removeEventListener('playing', onStreamVideoPlaying)
    videoRef.value?.removeEventListener('pause', onStreamPause)
    videoRef.value?.removeEventListener('play', onStreamPlay)
    videoRef.value?.removeEventListener('seeked', onStreamSeeked)
    stopAllStreamNodes()
    if (audioCtx.state === 'suspended')
      audioCtx.resume()

    if (audioPcmByChannel.size > 0) {
      const buf = buildAudioBuffer(currentChannel.value)
      if (buf) {
        audioBuffer = buf
        if (videoRef.value)
          bindVideoAudioSync(videoRef.value)
        if (videoRef.value && !videoRef.value.paused)
          startAudio(videoRef.value.currentTime)
        const { numberOfChannels, sampleRate, duration } = buf
        audioStatusText.value = `音频通道 ${currentChannel.value}（${numberOfChannels}ch · ${sampleRate} Hz · ${duration.toFixed(1)}s）`
      }
    }

    // 崩铁: wasm 无法解码 ADX 音频, 从累积的 USM 字节加载
    if (props.gameId === 'hkrpg' && audioPcmByChannel.size === 0 && accumulatedUsmBytes.length > 0) {
      const total = accumulatedUsmBytes.reduce((s, b) => s + b.length, 0)
      const usmBytes = new Uint8Array(total)
      let off = 0
      for (const b of accumulatedUsmBytes) {
        usmBytes.set(b, off)
        off += b.length
      }
      audioStatusText.value = '加载音频中...'
      try {
        await loadAdxAudio(usmBytes, signal)
        if (audioPcmByChannel.size === 0 && adxAudioBuffers.size === 0)
          audioStatusText.value = ''
      }
      catch (e) {
        if ((e as Error).name !== 'AbortError')
          audioStatusText.value = '音频加载失败'
      }
    }

    progress.value = 100
    progressLabel.value = '加载完成'
    phase.value = 'playing'
  }
  catch (e) {
    if ((e as Error).name === 'AbortError')
      return
    phase.value = 'error'
    errorMsg.value = (e as Error).message || String(e)
  }
}

async function streamDirect(
  dec: Awaited<ReturnType<typeof getUsmStreamDecoder>>,
  sbQueue: ReturnType<typeof makeSourceBufferQueue>,
  signal: AbortSignal,
) {
  // 通过服务器代理获取 USM (浏览器无法直连外部 CDN; 直链失效自动回退 chunk 组装)
  const params = new URLSearchParams()
  params.set('game', props.gameId)
  params.set('file', props.filePath)
  const gameDir = getGameDir(props.gameId)
  if (gameDir)
    params.set('game_dir', gameDir)
  if (props.directDownloadUrl)
    params.set('url', props.directDownloadUrl)
  if (props.bestChunkVersion)
    params.set('version', props.bestChunkVersion)
  const res = await fetch(`${API_BASE}/api/usm-proxy?${params}`, { signal })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    ;(err as any).preStream = true
    throw err
  }

  const total = Number(res.headers.get('Content-Length') ?? 0)
  let received = 0
  const reader = res.body!.getReader()

  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    if (signal.aborted)
      return

    received += value.byteLength
    accumulatedUsmBytes.push(value)
    if (total > 0) {
      progress.value = Math.min(99, Math.round((received / total) * 99))
      progressLabel.value = `${formatBytes(received)} / ${formatBytes(total)}`
    }
    else {
      progressLabel.value = `已接收 ${formatBytes(received)}`
    }

    const result = dec.push(value)
    if (result.init_segment)
      sbQueue.append(result.init_segment as Uint8Array)
    for (const c of result.clusters as Uint8Array[])
      sbQueue.append(c)
    for (const chunk of (result.audio_pcm_chunks ?? []))
      feedAudioChunk(chunk)

    await sbQueue.waitForCapacity(signal)
  }
}

async function streamChunks(
  chunkVersion: string,
  dec: Awaited<ReturnType<typeof getUsmStreamDecoder>>,
  sbQueue: ReturnType<typeof makeSourceBufferQueue>,
  signal: AbortSignal,
) {
  const res = await fetch(`${API_BASE}/chunk/${props.gameId}_${chunkVersion}.json`, { signal })
  if (!res.ok)
    throw new Error(`Chunk 列表获取失败：HTTP ${res.status}`)
  const json = await res.json()
  const manifests: ChunkManifest[] = json.data?.manifests ?? []

  let chunkUrlPrefix = ''
  let foundFile: { chunks: ParsedChunk[] } | null = null

  for (const m of manifests) {
    if (signal.aborted)
      return
    const cacheKey = `${props.gameId}_${chunkVersion}_${m.manifest.id}`
    const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
    let parsed
    try {
      parsed = await fetchAndParseManifest(url, cacheKey, Number(m.manifest.uncompressed_size), signal)
    }
    catch (e) {
      if ((e as Error).name === 'AbortError' || e instanceof TypeError)
        throw e
      continue
    }
    const match = parsed.files.find(f => f.path === props.filePath)
    if (match) {
      foundFile = match
      chunkUrlPrefix = m.chunk_download.url_prefix
      break
    }
  }

  if (!foundFile)
    throw new Error('无可用资源')

  const chunks = [...foundFile.chunks].sort((a, b) => a.offset - b.offset)

  await downloadChunks(chunks, chunkUrlPrefix, signal, async (decompressed, i, total) => {
    accumulatedUsmBytes.push(decompressed)
    const result = dec.push(decompressed)
    if (result.init_segment)
      sbQueue.append(result.init_segment as Uint8Array)
    for (const c of result.clusters as Uint8Array[])
      sbQueue.append(c)
    for (const pcmChunk of (result.audio_pcm_chunks ?? []))
      feedAudioChunk(pcmChunk)

    progress.value = Math.min(99, Math.round(((i + 1) / total) * 99))
    progressLabel.value = `Chunk ${i + 1} / ${total}`

    await sbQueue.waitForCapacity(signal)
  })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function handleClose() {
  abortController?.abort()
  if (streamAudioActive) {
    stopAllStreamNodes()
    streamAudioActive = false
  }
  stopAudio()
  adxAudioBuffers.clear()
  accumulatedUsmBytes = []
  if (videoAudioSyncCleanup) {
    videoAudioSyncCleanup()
    videoAudioSyncCleanup = null
  }
  if (audioCtx) {
    audioCtx.close()
    audioCtx = null
    gainNode = null
  }
  if (mediaSource && mediaSource.readyState === 'open') {
    try {
      mediaSource.endOfStream()
    }
    catch {}
  }
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)
  emit('close')
}

onMounted(() => startStreaming())
onUnmounted(() => {
  abortController?.abort()
  stopAllStreamNodes()
  stopAudio()
  adxAudioBuffers.clear()
  accumulatedUsmBytes = []
  if (videoAudioSyncCleanup)
    videoAudioSyncCleanup()
  if (audioCtx) {
    audioCtx.close()
    gainNode = null
  }
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/70" @click="handleClose" />
      <div class="relative flex w-full max-w-3xl flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <LucideFileVideo class="h-4 w-4 shrink-0 text-blue-500" />
          <span class="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{{ filename }}</span>
          <button
            class="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            @click="handleClose"
          >
            <LucideX class="h-4 w-4" />
          </button>
        </div>

        <div class="p-4">
          <div
            v-if="phase === 'error'"
            class="flex flex-col items-center gap-2 py-12 text-red-500"
          >
            <LucideAlertCircle class="h-8 w-8" />
            <p class="text-sm">
              {{ errorMsg }}
            </p>
            <button
              class="mt-2 text-xs text-blue-500 hover:text-blue-600"
              @click="showHelp = true"
            >
              出现 Failed to fetch？点击查看帮助
            </button>
          </div>

          <template v-else>
            <div class="relative overflow-hidden rounded-lg bg-black">
              <video
                ref="videoRef"
                controls
                autoplay
                class="max-h-[60vh] w-full"
              />
              <div
                v-if="phase === 'init' || (phase === 'buffering' && progress === 0)"
                class="absolute inset-0 flex items-center justify-center bg-black/60"
              >
                <LucideLoader2 class="h-8 w-8 animate-spin text-white" />
              </div>
            </div>

            <div class="mt-3 space-y-1.5">
              <div class="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  class="h-full rounded-full bg-blue-500 transition-all duration-300"
                  :style="{ width: `${progress}%` }"
                />
              </div>
              <div class="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
                <span>{{ progressLabel || '正在初始化...' }}</span>
                <span>{{ progress }}%</span>
              </div>
              <div v-if="audioChannelList.length > 0" class="flex items-center gap-2 flex-wrap pt-0.5">
                <span class="text-xs text-gray-400 dark:text-gray-500">音频通道</span>
                <button
                  v-for="ch in audioChannelList"
                  :key="ch"
                  class="rounded px-2 py-0.5 text-xs font-medium transition-colors"
                  :class="currentChannel === ch
                    ? 'bg-blue-500 text-white dark:bg-blue-600'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                  @click="switchChannel(ch)"
                >
                  {{ getChannelLabel(ch) }}
                </button>
                <div class="ml-auto flex items-center gap-2">
                  <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">音量</span>
                  <input
                    v-model.number="audioVolume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    class="h-1 w-24 cursor-pointer accent-blue-500"
                  >
                  <span class="w-8 text-right text-xs text-gray-400 dark:text-gray-500">{{ Math.round(audioVolume * 100) }}%</span>
                </div>
              </div>
              <div v-if="audioStatusText" class="text-xs text-gray-400 dark:text-gray-500">
                {{ audioStatusText }}
              </div>
              <div class="text-xs text-orange-400 dark:text-orange-500">
                浏览器存在较为严格的视频缓冲限制，拖动进度条后视频有概率出现播放中断或卡顿
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>

  <HelpModal v-if="showHelp" @close="showHelp = false" />
</template>
