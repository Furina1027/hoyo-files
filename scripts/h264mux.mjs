/**
 * H.264 Annex-B → 完整 MP4 封装 (纯 JS)
 * 用于播放器: USM 提取的 H.264 裸流转 MP4 后交给 <video>
 */

// ---------- exp-golomb 位读取器 ----------
class BitReader {
  constructor(bytes) {
    this.bytes = bytes
    this.bitPos = 0
  }
  readBits(n) {
    let val = 0
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.bitPos >> 3]
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1
      val = (val << 1) | bit
      this.bitPos++
    }
    return val
  }
  readUE() {
    let zeros = 0
    while (this.readBits(1) === 0)
      zeros++
    return (1 << zeros) - 1 + (zeros ? this.readBits(zeros) : 0)
  }
  readSE() {
    const ue = this.readUE()
    return (ue & 1) ? ((ue + 1) >> 1) : -((ue + 1) >> 1)
  }
  skip(n) {
    this.bitPos += n
  }
}

// ---------- SPS 解析 ----------
export function parseSps(sps) {
  const r = new BitReader(sps)
  r.skip(8) // nal header
  const profile = r.readBits(8)
  r.skip(8) // constraint flags
  const level = r.readBits(8)
  r.readUE() // sps id

  const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]
  let chromaFormat = 1
  if (highProfiles.includes(profile)) {
    chromaFormat = r.readUE()
    if (chromaFormat === 3)
      r.skip(1) // separate_colour_plane_flag
    r.readUE() // bit_depth_luma_minus8
    r.readUE() // bit_depth_chroma_minus8
    r.skip(1) // qpprime_y_zero_transform_bypass_flag
    if (r.readBits(1)) // seq_scaling_matrix_present_flag
      throw new Error('SPS scaling matrix not supported')
  }
  const log2MaxFrameNum = 4 + r.readUE()
  const picOrderCntType = r.readUE()
  if (picOrderCntType === 0) {
    r.readUE() // log2_max_pic_order_cnt_lsb_minus4
  }
  else if (picOrderCntType === 1) {
    r.skip(1) // delta_pic_order_always_zero_flag
    r.readSE() // offset_for_non_ref_pic
    r.readSE() // offset_for_top_to_bottom_field
    const numRefFramesInPocCycle = r.readUE()
    for (let i = 0; i < numRefFramesInPocCycle; i++)
      r.readSE() // offset_for_ref_frame[i]
  }
  const maxNumRefFrames = r.readUE()
  r.skip(1) // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbs = r.readUE() + 1
  const picHeightInMapUnits = r.readUE() + 1
  const frameMbsOnly = r.readBits(1)
  let picHeightInMbs = picHeightInMapUnits * (2 - frameMbsOnly)
  if (!frameMbsOnly)
    r.skip(1) // mb_adaptive_frame_field_flag
  r.skip(1) // direct_8x8_inference_flag

  // crop
  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0
  if (r.readBits(1)) {
    cropLeft = r.readUE()
    cropRight = r.readUE()
    cropTop = r.readUE()
    cropBottom = r.readUE()
  }
  const cropUnitX = chromaFormat === 0 ? 1 : 2
  const cropUnitY = chromaFormat === 0 ? 2 : 2 * (2 - frameMbsOnly)
  const width = picWidthInMbs * 16 - (cropLeft + cropRight) * cropUnitX
  const height = picHeightInMbs * 16 - (cropTop + cropBottom) * cropUnitY

  // VUI → 帧率
  let fps = 30
  let timescale = 30
  let numUnitsInTick = 1
  if (r.readBits(1)) { // vui_parameters_present_flag
    if (r.readBits(1)) { // aspect_ratio_info_present_flag
      const aspectIdc = r.readBits(8)
      if (aspectIdc === 255) {
        r.skip(16)
        r.skip(16)
      }
    }
    if (r.readBits(1)) r.skip(1) // overscan
  if (r.readBits(1)) { // video_signal_type_present_flag
    r.skip(3) // video_format
    r.skip(1) // video_full_range_flag
    if (r.readBits(1)) { // colour_description_present_flag
      r.skip(8) // colour_primaries
      r.skip(8) // transfer_characteristics
      r.skip(8) // matrix_coefficients
    }
  }
  if (r.readBits(1)) { // chroma_loc_info_present_flag
    r.readUE() // chroma_sample_loc_type_top_field
    r.readUE() // chroma_sample_loc_type_bottom_field
  }
    if (r.readBits(1)) { // timing_info_present_flag
      numUnitsInTick = r.readBits(32)
      timescale = r.readBits(32)
      r.skip(1) // fixed_frame_rate_flag
      if (numUnitsInTick > 0 && timescale > 0) {
        const f = timescale / numUnitsInTick
        if (f >= 1 && f <= 120)
          fps = f
      }
    }
  }

  return { profile, level, width, height, fps, timescale, numUnitsInTick }
}

// ---------- NAL 工具 ----------
export function splitAnnexB(data) {
  const nalus = []
  let i = 0
  const len = data.length
  while (i < len) {
    // 找起始码
    let start = -1
    for (let j = i; j + 3 < len; j++) {
      if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))) {
        start = j
        break
      }
    }
    if (start < 0)
      break
    let end = start + 3
    if (data[start + 2] === 0)
      end = start + 4
    // 找下一个起始码
    let next = len
    for (let j = end; j + 3 < len; j++) {
      if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))) {
        next = j
        break
      }
    }
    nalus.push(data.slice(end, next))
    i = next
  }
  return nalus
}

export function nalType(nal) {
  return nal[0] & 0x1f
}

// ---------- MP4 box 工具 ----------
function box(type, ...payloads) {
  let size = 8
  for (const p of payloads)
    size += p.length
  const buf = new Uint8Array(size)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, size)
  buf[4] = type.charCodeAt(0)
  buf[5] = type.charCodeAt(1)
  buf[6] = type.charCodeAt(2)
  buf[7] = type.charCodeAt(3)
  let off = 8
  for (const p of payloads) {
    buf.set(p, off)
    off += p.length
  }
  return buf
}

function fullBox(type, version, flags, ...payloads) {
  const head = new Uint8Array(4)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, (version << 24) | flags)
  return box(type, head, ...payloads)
}

function u32(v) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v)
  return b
}

function u16(v) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, v)
  return b
}

function u8(v) {
  return new Uint8Array([v])
}

// ---------- 主转换: Annex-B → MP4 ----------
export function annexbToMp4(h264, { fps = 30 } = {}) {
  const nalus = splitAnnexB(h264)
  if (!nalus.length)
    throw new Error('无 NAL 单元')

  // 提取 SPS/PPS
  let sps = null
  let pps = null
  for (const nal of nalus) {
    const t = nalType(nal)
    if (t === 7 && !sps)
      sps = nal
    else if (t === 8 && !pps)
      pps = nal
  }
  if (!sps || !pps)
    throw new Error('缺少 SPS/PPS')

  const spsInfo = parseSps(sps) // parseSps 内部跳过 nal header
  const frameRate = spsInfo.fps && spsInfo.fps >= 1 && spsInfo.fps <= 120 ? spsInfo.fps : fps
  const timescale = 1000
  const frameDuration = Math.round(timescale / frameRate)

  // 按 access unit 分组: AUD 或 IDR 处切帧
  const frames = []
  let cur = []
  for (const nal of nalus) {
    const t = nalType(nal)
    if (t === 9) { // AUD
      if (cur.length)
        frames.push(cur)
      cur = []
    }
    if (t >= 1 && t <= 5) { // VCL
      cur.push(nal)
    }
    else if (t === 6 || t === 7 || t === 8) {
      cur.push(nal)
    }
  }
  if (cur.length)
    frames.push(cur)

  if (!frames.length)
    throw new Error('无视频帧')

  // 简化: 忽略 B 帧 reorder (PTS = DTS); 对无 B 帧的引导视频正确
  const frameData = frames.map(frame => {
    // mdat 中只放 VCL NAL (长度前缀)
    let size = 0
    for (const nal of frame) {
      const t = nalType(nal)
      if (t >= 1 && t <= 5)
        size += 4 + nal.length
    }
    const buf = new Uint8Array(size)
    let off = 0
    for (const nal of frame) {
      const t = nalType(nal)
      if (t >= 1 && t <= 5) {
        new DataView(buf.buffer).setUint32(off, nal.length)
        off += 4
        buf.set(nal, off)
        off += nal.length
      }
    }
    return buf
  })

  const mdatSize = frameData.reduce((s, f) => s + f.length, 0)

  // avcC (与 ffmpeg movenc 一致: SPS/PPS 含 nal header, numSPS=0xE1 为 3bit保留+5bit数量)
  const avcC = (() => {
    const arr = new Uint8Array(11 + sps.length + pps.length)
    arr[0] = 1
    arr[1] = sps[1]
    arr[2] = sps[2]
    arr[3] = sps[3]
    arr[4] = 0xff // lengthSizeMinusOne = 3
    arr[5] = 0xe1 // 3 bits reserved + 5 bits numSPS = 1
    arr[6] = (sps.length >> 8) & 0xff
    arr[7] = sps.length & 0xff
    arr.set(sps, 8)
    arr[8 + sps.length] = 1 // numPPS
    arr[9 + sps.length] = (pps.length >> 8) & 0xff
    arr[10 + sps.length] = pps.length & 0xff
    arr.set(pps, 11 + sps.length)
    return arr
  })()

  // stsd avc1
  const sampleEntry = (() => {
    const pre = new Uint8Array(78)
    new DataView(pre.buffer).setUint16(0, 0) // reserved
    new DataView(pre.buffer).setUint16(2, 0)
    for (let i = 4; i < 8; i++)
      pre[i] = 0
    for (let i = 8; i < 24; i++)
      pre[i] = 0 // predefined
    new DataView(pre.buffer).setUint16(24, spsInfo.width)
    new DataView(pre.buffer).setUint16(26, spsInfo.height)
    new DataView(pre.buffer).setUint32(28, 0x00480000) // horizresolution 72dpi
    new DataView(pre.buffer).setUint32(32, 0x00480000)
    new DataView(pre.buffer).setUint32(36, 0) // reserved
    new DataView(pre.buffer).setUint16(40, 1) // frame_count
    for (let i = 42; i < 74; i++)
      pre[i] = 0
    new DataView(pre.buffer).setUint16(74, 24) // depth
    new DataView(pre.buffer).setUint16(76, 0xffff) // pre_defined
    const avcCbox = box('avcC', avcC)
    return box('avc1', pre, avcCbox)
  })()

  const stsd = fullBox('stsd', 0, 0, u32(1), sampleEntry)
  const stts = fullBox('stts', 0, 0, u32(1), u32(frames.length), u32(frameDuration))
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1))
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(frames.length), ...frameData.map(f => u32(f.length)))
  const stco = fullBox('stco', 0, 0, u32(1), u32(0)) // mdat 内偏移, 后面回填

  const stbl = box('stbl', stsd, stts, stsc, stsz, stco)
  const vmhd = fullBox('vmhd', 0, 0, u16(1), u16(0), u16(0), u16(0))
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)))
  const minf = box('minf', vmhd, dinf, stbl)
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(frames.length * frameDuration), u16(0x55c4))
  const hdlr = fullBox('hdlr', 0, 0, u32(0), boxStr('vide'), u32(0), u32(0), u32(0))
  const mdia = box('mdia', mdhd, hdlr, minf)
  const tkhd = fullBox('tkhd', 0, 0x7, u32(0), u32(0), u32(0), u32(0), u32(frames.length * frameDuration), u32(timescale), u16(0), u16(0), u16(0), u16(0), matrix(), u32(spsInfo.width << 16), u32(spsInfo.height << 16))
  const trak = box('trak', tkhd, mdia)
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(frames.length * frameDuration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), matrix(), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0))
  const moov = box('moov', mvhd, trak)

  // ftyp
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'))

  // mdat
  const mdat = (() => {
    const buf = new Uint8Array(8 + mdatSize)
    new DataView(buf.buffer).setUint32(0, 8 + mdatSize)
    buf[4] = 'm'.charCodeAt(0)
    buf[5] = 'd'.charCodeAt(0)
    buf[6] = 'a'.charCodeAt(0)
    buf[7] = 't'.charCodeAt(0)
    let off = 8
    for (const f of frameData) {
      buf.set(f, off)
      off += f.length
    }
    return buf
  })()

  // 回填 stco 偏移 (ftyp + moov + mdat 头 8 字节)
  const moovOffset = ftyp.length + moov.length + 8
  const stcoBox = (() => {
    const arr = new Uint8Array(stco)
    new DataView(arr.buffer).setUint32(16, moovOffset)
    return arr
  })()

  // 重建 moov (含回填的 stco)
  const stbl2 = box('stbl', stsd, stts, stsc, stsz, stcoBox)
  const minf2 = box('minf', vmhd, dinf, stbl2)
  const mdia2 = box('mdia', mdhd, hdlr, minf2)
  const trak2 = box('trak', tkhd, mdia2)
  const moov2 = box('moov', mvhd, trak2)

  const out = new Uint8Array(ftyp.length + moov2.length + mdat.length)
  out.set(ftyp, 0)
  out.set(moov2, ftyp.length)
  out.set(mdat, ftyp.length + moov2.length)
  return out
}

function boxStr(s) {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++)
    b[i] = s.charCodeAt(i)
  return b
}

function str(s) {
  return boxStr(s)
}

function matrix() {
  const b = new Uint8Array(36)
  const dv = new DataView(b.buffer)
  dv.setUint32(0, 0x00010000)
  dv.setUint32(16, 0x00010000)
  dv.setUint32(32, 0x40000000)
  return b
}
