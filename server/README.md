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
POST /api/refresh/:game                 一键刷新 (启动器凭据 → 预下载差异/文件清单)
GET  /api/predownload-summary/:game     预下载汇总 (各 tag 统计, 小响应)
GET  /api/predownload/:game?tag&dir&q   目录浏览 (按需加载, 与游戏内目录一致)
POST /api/predownload-download/:game    下载预下载文件 (files[] 或 dirs[], 按游戏内目录落盘)
```

刷新逻辑 (server/refresh.mjs, 零依赖):

1. `getGameBranches` 启动器接口 → 当前版本 + 预下载分支的 包ID/密码 (官方最新凭据)
2. 预下载存在 → `getPatchBuild` → 下载校验全部 manifest → 生成 `predownload/{game}.json`
   (含每个文件的 bundle 定位信息, 供下载功能使用)
3. 当前版本本地无文件清单 → `getBuild` → 生成 `{game}/{ver}/pkg_version` + chunk 快照
4. 更新 `{game}_versions.json` 的当前版本条目与凭据

预下载文件下载 (无需本地客户端文件):

- 单文件: 浏览器端 chunk 直下 (与文件列表页完全一致), 沙箱/网络受限时自动回退服务器
- 目录/全部: 服务器 chunk 直下优先, 失败回退 diff
- 下载顺序: chunk 直下 (目标版本 chunk CDN 可用时) → diff 重建
  (新增=hpatchz 空源, 修改=需游戏目录原文件, 仅当 chunk 数据不可用时)
- 输出: 服务器下载到 `downloads/{game}/<游戏内路径>`; 浏览器直下为保存对话框
- 目标版本 chunk 索引首次生成约 5-10 秒, 之后秒回 (`chunk/{game}_{ver}.index.json`)

## 刷新数据 (可选)

数据由「设置 → 数据管理」的刷新按钮维护，无需命令行。
如需用外部工具（如 hoyo-sophon）单独刷预下载数据：

```bash
cd ../hoyo-sophon
python -m sophon predownload --versions ../pkg_version/nap_versions.json \
    --game nap -o ../pkg_version/predownload/nap.json
```

没有活动预下载时命令会提示 "当前没有活动预下载", 前端页面显示「暂无预下载数据」。

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
