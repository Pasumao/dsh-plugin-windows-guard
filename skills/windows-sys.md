---
name: windows-sys
description: Windows 系统环境防坑守则：路径与文件系统（MAX_PATH 长路径、空格/中文路径、文件占用 EACCES/EBUSY、junction 与 link: 安装、路径格式）、进程与端口（netstat 查端口、Stop-Process/taskkill、先查后杀）、跨平台杂项（CRLF 换行、.cmd 脚本宿主/ExecutionPolicy、时区、大小写不敏感）。排查路径报错、文件被占用、端口/进程问题时加载。
whenToUse: 路径/文件系统报错、文件占用、进程管理、端口冲突、CRLF/换行、跨平台脚本、环境排查时
---

# Windows 系统环境守则（windows-sys）

本守则针对 Windows 「系统环境」类问题：路径、文件占用、进程/端口、换行与跨平台。
与 windows-enc（编码/转义/乱码）互补；判断成败仍看 `[exit code: N]`（真相唯一权威）。

## 1. 路径与文件系统

- **长路径**：Windows MAX_PATH 260 字符（未开长路径支持时）。Node 处理
  `C:\Users\...\AppData\Local\npm-cache\_npx\**\node_modules\...` 这类深层路径已接近
  极限；报 ENOENT/EPERM 且路径很长时，先缩短路径（`subst` / 浅层目录）再查真正原因。
- **空格/中文路径**：Node 已自动处理，但 PowerShell 里输路径用引号包住：
  `Get-ChildItem "D:\my project\file.json"`。
- **文件占用/权限**（`EACCES`/`Access is denied`/`EBUSY`）：Windows 上被进程打开的文件
  无法删除/重写；先停占用进程（见第 2 节）再操作。别名 `realpath '...sock'` 等
  对 socket/管道文件报 EACCES 是正常保护，不是出 bug，别据此怀疑权限。
- **符号链接 & `link:`**：dsh 插件以 `link:` 装入 profile，Node 按 **realpath** 解析——
  插件里引用的外部依赖必须装在插件自己的 node_modules，不能假设能从 profile 解析。
  移动含 junction 的目录用 robocopy 或先解除链接，别用普通复制。
- **路径格式**：Windows 下用原生日志 `C:\...`；向 Node/JSON 传路径时双反斜杠
  （`"C:\\dsh"`）或在 JS 里用 String.raw。

## 2. 进程与端口（先查后杀）

```powershell
# 查端口占用（3080 = dsh web，39090 = launcher 启动页）
netstat -ano | findstr :3080

# 查进程
Get-Process -Id 12345 | Format-List Id, ProcessName, Path
tasklist | findstr /i "node"

# 杀进程（Force 必要；确认 PID 是目标再杀）
Stop-Process -Id 12345 -Force
taskkill /F /PID 12345
```

- 杀进程**前先确认** PID（任务名/命令行参数核对），Windows 上杀错进程没有
  UNDO；残留孤儿进程是「端口被占/文件被锁」的头号原因。
- `dsh` 相关：后端是 node；launcher 是 DshLauncher.exe。改 profile 后先
  `node D:\dsh\scripts\check-profile.mjs` 自检再重启。

## 3. 跨平台与杂项

- **换行符**：写脚本/配置文件统一 **LF**；PowerShell 的 `"..."` 字符串含 `\r\n` 时会
  悄悄变成 CRLF。检查：`Format-Hex -Path f | Select-Object -First 1`（0D 0A = CRLF）。
  git 里 `core.autocrlf` 会改写，跨团队项目先约定（本机推荐
  `git config core.autocrlf false` + `.gitattributes` 显式声明）。
- **脚本宿主**：npm/pnpm 在 Windows 的 bin 是 `.cmd`；PowerShell 执行 `.cmd`/`.bat`
  常见 `-ExecutionPolicy Bypass` 需求。跨平台脚本优先用 Node/Python 直跑，不经 shell。
- **时区**：日志/文件时间常是 UTC 或本地混用，比对时间先断言时区
  （`Get-Date` vs `Get-Date -AsUTC`）。
- **大小写**：Windows 路径大小写不敏感，但 git/Node 比较敏感——重命名只改大小写
  时要 git mv 两步走，否则文件不识别。
