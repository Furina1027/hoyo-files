# third_party

## hpatchz.exe

来自 [HDiffPatch](https://github.com/sisong/HDiffPatch)（MIT License）的 Windows x64 命令行二进制，
被 `server/refresh.mjs` 用于 hdiff 补丁应用（预下载文件 diff 重建：新增文件 = 空源应用，修改文件 = 需对应旧版原文件）。

- 查找顺序：环境变量 `HPATCHZ` → `../../hoyo-sophon/third_party/hpatchz.exe` → `../third_party/hpatchz.exe`（本目录）
- 缺失时相关功能报错，但站点本体不受影响；也可从上游 releases 自行下载替换
