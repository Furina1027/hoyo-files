# 本地运行

数据服务器指向本地 pkg_version 数据仓库 (默认 `../pkg_version`)。

```bash
# 1. 安装前端依赖 (首次)
pnpm install

# 2. 启动数据服务器 (端口 8787)
pnpm server

# 3. 另开终端启动前端开发服务器
pnpm dev
```

访问 `http://localhost:8600`。前端通过 `VITE_API_BASE` 读取数据:

```bash
# .env.local (已按本地配置创建, 可修改)
VITE_API_BASE="http://localhost:8787"
```

## 前端一键刷新 (无需命令行)

数据服务器内置刷新接口, 网站「设置 → 数据管理」面板与「预下载」页面均有刷新按钮:

```
GET  /api/games                         各游戏数据状态
POST /api/refresh/:game                 一键刷新 (版本/chunk/直链安装包/预下载差异/清单/USM 历史)
GET  /api/predownload-summary/:game     预下载汇总 (各 tag 统计, 小响应)
GET  /api/predownload/:game?tag&dir&q   目录浏览 (按需加载, 与游戏内目录一致)
POST /api/predownload-download/:game    下载预下载文件 (files[] 或 dirs[], 按游戏内目录落盘)
```

刷新逻辑 (server/refresh.mjs, 零依赖, 不依赖任何上游数据仓库):

1. `getGameBranches` 启动器接口 → 当前版本 (`main`) + 预下载分支 (`pre_download`) 的 包ID/密码/tag
2. `getGamePackages` → 直链安装包: `major` (完整包分卷 / 语音包 / `res_list_url`) 与 `patches`
   (增量包); 只有 `major.version === 目标 tag` 时才采用 (全量包停发后官方仍会返回旧版本)
3. 预下载存在 → `getPatchBuild` → 下载校验全部 manifest → 生成 `predownload/{game}.json`
   (含每个文件的 bundle 定位信息, 供下载功能使用)
4. 预下载版本 (`pre_download.tag` > `main.tag`) → `getBuild(branch=predownload)` 返回的是
   **下一版本完整包** → 与正式版完全同构地落盘:
   - `chunk/{game}_{ver}.json` (chunk 快照)
   - `{game}/{ver}/pkg_version` + `Audio_*_pkg_version` (从 chunk 下载清单本体)
   - `{game}_versions.json` 版本条目 (chunk 凭据 + 直链安装包)
5. 当前版本 → `getBuild(branch=main)`; build_id 未变且清单已存在则只更新凭据, 变了才重下清单
6. 同步更新 `usm/{game}_history.json` (预下载版本优先使用自己的完整清单)

> 发布日官方只把预下载分支移到 `main`: 再刷新一次即可, build 未变时复用本地清单与快照,
> 仅更新 `chunk.branch` 等凭据, 前端无需任何迁移操作。

预下载文件下载 (无需本地客户端文件):

- 单文件: 浏览器端 chunk 直下 (与文件列表页完全一致), 沙箱/网络受限时自动回退服务器
- 目录/全部: 服务器 chunk 直下优先, 失败回退 diff
- 下载顺序: chunk 直下 (目标版本 chunk CDN 可用时) → diff 重建
  (新增=hpatchz 空源, 修改=需游戏目录原文件, 仅当 chunk 数据不可用时)
- 输出: 服务器下载到 `downloads/{game}/<游戏内路径>`; 浏览器直下为保存对话框
- 目标版本 chunk 索引首次生成约 5-10 秒, 之后秒回 (`chunk/{game}_{ver}.index.json`)

## 数据维护

数据完全由「设置 → 数据管理」的刷新按钮维护，无需命令行，也不依赖任何上游数据仓库；
刷新会同时更新版本条目、文件清单、chunk 快照、直链安装包、预下载差异与 USM 历史。

## USM 在线播放

key 文件位于数据仓库 `usm/{game}_keys.json`, 格式为文件名(去 `.usm` 后缀)到
16 位 hex 解密 key 的映射, 例如:

```json
{
  "CS_Chap01_Act010_f": "00D0E9FAACDD1F0E"
}
```

- `hk4e_keys.json` / `hkrpg_keys.json` / `nap_keys.json` 均已就绪

播放逻辑与原神完全一致: 服务器提供 `usm/{game}_history.json` 文件历史与 key,
浏览器端 wasm 解码 (USM → WebM + 多音轨) 流式播放。

## 扩展新游戏

前端 `src/constants/core.ts` 的 `GameList` 加一条; 服务器 `server/refresh.mjs` 的
`GAMES` 加对应配置 (启动器ID/游戏ID), 然后网站
「设置 → 数据管理」点一次刷新即可完成 bootstrap (版本条目 + 文件清单 + 预下载),
无需任何命令行操作。已内置: hk4e / hkrpg / nap / bh3。
