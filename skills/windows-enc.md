---
name: windows-enc
description: Windows 编码与 PowerShell 解析防坑守则：读文件乱码（GBK/ANSI 误解码）、写 JSON/YAML 被 BOM 或 UTF-16 破坏、PowerShell 单引号转义、node -e/python -c 引号地狱、stderr 误判、乱码识别与三不原则。读写文件、中文输出、命令解析失败、出现 鈥?/鎻掍欢/锟斤拷 等乱码时加载。
whenToUse: 读/写文本与配置文件、处理中文输出、命令引号转义、JSON/YAML 解析失败、乱码排查时
---

# Windows 编码与 PowerShell 解析守则（windows-enc）

本守则针对 Windows 上「命令/文件内容出错」类问题：读了文件变乱码、写了文件解析
失败、引号转义写错、stderr 误判。目标：一次写对，不要出错。

## 1. 环境事实卡（先记住，避免误判）

- dsh 的 `pwsh` 工具在 Windows 上运行 **PowerShell 7（若安装）或 5.1 兜底**；命令经
  `-Command` 作为**单个 argv** 传入，**没有** bash 风格 shell 转义层——不要在命令上
  叠加 `\"` / `\'` 等 bash 转义。
- dsh 已在每条命令前自动执行 `[Console]::OutputEncoding = UTF8` 与
  `$OutputEncoding = UTF8`（pwsh 7 默认即 UTF-8）——**命令输出本身不会乱码**；
  乱码几乎都来自「读文件」与「写文件」环节，不是管道。
- 判断成败只看 **`[exit code: N]` / `$LASTEXITCODE`**；`[stderr]` 有内容 ≠ 失败
  （PowerShell 会把不少正常信息写 stderr，git 进度 `To https://...` 还会被渲染成
  红色「错误」）。Exit code 0 = 成功；非零才排查。

## 2. 编码三铁律（最高频坑，务必逐条执行）

| 场景 | ❌ 错 | ✅ 对 |
|---|---|---|
| 读文本文件 | `Get-Content foo.json`（5.1 按 ANSI/GBK 解码，中文变 `鈥?`/`鎻掍欢`） | `Get-Content -Encoding UTF8 foo.json` |
| 写 JSON/YAML/MD | `Set-Content -Path a.json -Value $x` / `$x > a.json`（5.1 写 UTF-16LE 或 BOM） | `[System.IO.File]::WriteAllText("a.json", $x, [System.Text.UTF8Encoding]::new($false))` |
| pwsh 7 写文件 | `Out-File -Encoding utf8`（5.1 下 = 带 BOM；7 下无 BOM） | `Out-File -Encoding utf8NoBOM`（仅 pwsh 7） |

补充：
- **配套零 token 工具**（本插件注册，优先于手写嗅探/转换命令）：
  `windows_encode_detect`（诊断 BOM/UTF-8/GBK/UTF-16 + 置信度）与
  `windows_encode_fix`（转成 UTF-8 无 BOM，自动备份 `<path>.windowsguard.bak`，
  支持 `dryRun`）。遇到乱码或 JSON/YAML 解析失败时，先 detect 后 fix，再复检。
- **查文件编码**（无工具可用时的替代）：`Format-Hex -Path a.json -Count 3`——
  `EF BB BF` = UTF-8 BOM（解析器可能拒绝）；`FF FE` = UTF-16LE（必然炸 JSON）；
  无 BOM 且含 `FF FD` 替换符 = 文件本来就被写坏了。
- **GBK→UTF-8 转换**（确证文件是 GBK 时，PowerShell 无直接 cmdlet，用 .NET）：
  `[System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::GetEncoding(936)), [System.Text.UTF8Encoding]::new($false))`
- **只读不改写**：`dsh` 的 `write`/`edit` 工具写 UTF-8 无 BOM，改配置优先用它
  而不是 PowerShell 重定向。

## 3. 引号转义速查（解析失败的根源）

- PowerShell 单引号字符串里，单引号用**两个单引号**转义：`'it''s fine'`；
  **反斜杠转义在 PowerShell 里无效**（`\'` 会被当普通字符）。
- 需要变量插值才用双引号：`"$env:USERPROFILE\path"`（`$` 会插值；不想要插值用单引号）。
- 传参给外部程序（node.exe / python.exe）有引号嵌套时，**不要逐层转义**，改为一层：
  - 首选：`& node.exe "C:\path\script.mjs" "arg with space"`（参数各自加引号）
  - 复杂脚本：**写临时文件** `node C:\Users\...\AppData\Local\Temp\script.mjs` 再执行，
    避免 `node -e "..."` 里再嵌 `"` 与 `'` 的地狱（历史实录：
    `SyntaxError: unterminated string literal` 即由此而来）。
  - `cmd /c` 更糟：cmd 有自己的引号规则，能用 PowerShell 就不用 cmd。

## 4. 输出判断：见到乱码怎么办（三不原则）

常见乱码特征与成因：

| 症状 | 成因 | 处理 |
|---|---|---|
| `鈥?` `锟斤拷` `鎻掍欢` `鏋勮瑙勮寖` | UTF-8 字节被按 GBK 解码（读了文件没带 `-Encoding`，或文件本就是 GBK） | 按第 2 节：带 `-Encoding UTF8` 重读；`Format-Hex` 查文件真编码 |
| `??OK??` `??? 中文` | 中文在某环节被转成 ASCII（UTF-8→ANSI 丢失，无法恢复） | 回源头重新获取原文；不要靠猜 |
| `\uFFFD\uFFFD` | 解码失败替换符 | 同上，先转码再读 |

**三不原则**：
1. **不猜**——乱码文本语义不可信，别试图「意思理解一下」继续用；
2. **不引用**——不要把它当答案、文件名、配置值传给下游；
3. **先重读**——回到源头（原文件原命令）按守则重新读/重新执行。

附：pwsh 工具输出出现乱码时，本插件会自动在结果后追加 `[windows-guard]` 修复提示；
文件类乱码直接走 `windows_encode_detect` / `windows_encode_fix` 工具链。
