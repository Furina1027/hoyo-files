/** Node 验证: USM demux → H.264 → MP4 → ffmpeg 校验 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { extractVideoStream } = await import(pathToFileURL(path.join(ROOT, 'src/utils/usm_demux.ts')).href)
const { annexbToMp4, parseSps, splitAnnexB, nalType } = await import('./h264mux.mjs')

const usmPath = process.argv[2]
if (!usmPath) {
  console.error('用法: node scripts/test_h264_mux.mjs <input.usm> [output.mp4]')
  process.exit(1)
}
const usm = fs.readFileSync(usmPath)
console.log('USM 大小:', usm.length)

// 1. demux 提取视频流
const video = extractVideoStream(new Uint8Array(usm))
console.log('视频流:', video.length, '字节, 头部:', Buffer.from(video.slice(0, 8)).toString('hex'))

// 2. SPS 解析
const nalus = splitAnnexB(video)
const sps = nalus.find(n => nalType(n) === 7)
if (sps) {
  console.log('SPS 长度:', sps.length, '头部:', Buffer.from(sps.slice(0, 12)).toString('hex'))
  const info = parseSps(sps)
  console.log('SPS:', JSON.stringify(info))
}

// 3. 转 MP4
const mp4 = annexbToMp4(video)
const mp4Path = process.argv[3] || 'out.mp4'
fs.writeFileSync(mp4Path, mp4)
console.log('MP4:', mp4.length, '字节 ->', mp4Path)
