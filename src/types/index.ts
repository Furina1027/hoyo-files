export interface GameConfig {
  id: string
  name: string
  pages: string[]
  domains: string[]
  audioLangs?: string[]
  features?: ('usm-decode')[]
}

export interface AppPage {
  id: string
  name: string
  component: () => Promise<unknown>
}

export interface PkgFile {
  name: string
  url: string
  checksum: string
  size: number
}

export interface VoiceMap {
  'zh-cn'?: PkgFile
  'en-us'?: PkgFile
  'ja-jp'?: PkgFile
  'ko-kr'?: PkgFile
}

export interface UpdateEntry {
  game?: PkgFile
  voice: VoiceMap
}

export interface ChunkInfo {
  branch: string
  package_id: string
  password: string
  tag: string
  diff_tags?: string[]
}

export interface VersionData {
  game: {
    full?: PkgFile
    segments?: PkgFile[]
  }
  voice: VoiceMap
  update: Record<string, UpdateEntry>
  decompressed_path: string | null
  chunk: ChunkInfo | null
}

export interface ChunkManifestStats {
  compressed_size: string
  uncompressed_size: string
  file_count: string
  chunk_count: string
}

export interface ChunkManifest {
  category_id: string
  category_name: string
  manifest: {
    id: string
    checksum: string
    compressed_size: string
    uncompressed_size: string
  }
  chunk_download: {
    encryption: number
    password: string
    compression: number
    url_prefix: string
    url_suffix: string
  }
  manifest_download: {
    encryption: number
    password: string
    compression: number
    url_prefix: string
    url_suffix: string
  }
  matching_field: string
  stats: ChunkManifestStats
  deduplicated_stats: ChunkManifestStats
}

export interface GameFileRecord {
  remoteName: string
  md5: string
  hash?: string
  fileSize: number
}

export interface VersionEntry {
  version: string
  state: 'AVAILABLE' | 'DELETED'
  md5: string | null
  size: number | null
}

export interface FileRecord {
  filename: string
  state: 'AVAILABLE' | 'DELETED'
  versions: VersionEntry[]
}

export interface ParsedChunk {
  id: string
  checksum: string
  offset: number
  compressedSize: number
  uncompressedSize: number
}

export interface ParsedFile {
  path: string
  chunks: ParsedChunk[]
  isFolder: boolean
  size: number
  checksum: string
}

export interface ParsedManifest {
  files: ParsedFile[]
}

export type DownloadStatus
  = | 'pending'
    | 'downloading'
    | 'decompressing'
    | 'merging'
    | 'success'
    | 'failed'
    | 'cancelled'

export interface DownloadTask {
  id: string
  type: 'manifest-json' | 'chunk-file' | 'usm-mkv-export'
  status: DownloadStatus
  name: string
  progress: number
  error?: string
}

export interface FileBrowserAudioOption {
  lang: string
  label: string
  active: boolean
  loading: boolean
}

export interface FileBrowserSource {
  version: string
  files: GameFileRecord[]
  isLoading: boolean
  error: string | null
  decompressedPath: string | null
  hasChunk: boolean
  audioOptions?: FileBrowserAudioOption[]
}

// ---- 预下载 (patch 模式) ----

export interface PredownloadDiffEntry {
  file: string
  size: number
  md5: string
  original_file?: string
  original_size?: number
}

export interface PredownloadTagDiff {
  entries: {
    added: PredownloadDiffEntry[]
    modified: PredownloadDiffEntry[]
    deleted: PredownloadDiffEntry[]
  }
  stats: {
    added: number
    modified: number
    deleted: number
    added_size: number
    modified_size: number
    deleted_size: number
  }
}

export interface PredownloadData {
  game: string
  current_version: string
  predownload_version: string
  build_id: string
  generated_at: string
  tags: string[]
  diffs: Record<string, PredownloadTagDiff>
}
