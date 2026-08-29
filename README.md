# dsh-plugin-windows-guard

DeepSeek Harness (dsh) 的 **Windows 环境防坑插件**：守则（skill）+ 主动防护（hooks/工具）。

把本机 255 个会话归档里反复出现的 Windows 高频坑，沉淀成两层能力：

- **守则层**（0.1.0 起）：两个自包含 skill 按场景自动加载——「一次写对」的预防性守则；
- **主动防护层**（0.2.0 起，自 `dsh-plugin-pwsh-guard` 合并，该插件已删除）：
  pwsh 结果乱码自动检测提示、危险写命令拦截、编码诊断/修复工具。

零运行时依赖、零构建。

## 功能

### 守则层：两个自动加载的技能

按触发场景拆成两个自包含技能（`<available_skills>` 按 description 匹配自动加载正文）：

### `windows-enc` —— 编码与 PowerShell 解析（命令/文件内容出错类）

| 章节 | 内容 | 来源问题（历史实录） |
|---|---|---|
| 1 环境事实卡 | pwsh 5.1/7 差异、`-Command` 单 argv 无 shell 转义层、OutputEncoding 已钉、退出码权威 | stderr 误判（git 红色进度、NativeCommandError） |
| 2 编码三铁律 | 读必带 `-Encoding UTF8`；写结构化文件用 `WriteAllText(UTF8Encoding($false))`；查 BOM/转码命令模板 | GBK 误解码（`鎻掍欢`/`鈥?`）、BOM 写坏 package.json（启动事故二）、UTF-16 写坏 |
| 3 引号转义速查 | PS `''` 转义（反斜杠无效）、双引号插值、`node -e`/`python -c` 引号地狱 → 写临时文件 | `SyntaxError: unterminated string literal`、实测引号嵌套失败 |
| 4 乱码三不原则 | 乱码特征表（`鈥?`/`??OK??`/`\uFFFD`）+ 不猜/不引用/先重读 | `??OK??`、`??? skill ????` 乱码当答案 |

### `windows-sys` —— 系统环境（排查类）

| 章节 | 内容 | 来源问题 |
|---|---|---|
| 1 路径与文件系统 | MAX_PATH/长路径、空格路径、EACCES/EBUSY 文件占用、junction 与 `link:` realpath、路径格式 | `EACCES: realpath '...sock'`、npm-cache 深层路径 |
| 2 进程与端口 | `netstat` 查端口、`Stop-Process`/`taskkill`、先查后杀 | 3080/39090 端口占用、孤儿进程 |
| 3 跨平台杂项 | CRLF 陷阱、`.cmd` 脚本宿主/ExecutionPolicy、时区、大小写 | 小说文件 CRLF 检查、run.bat chcp 65001 |

### 主动防护层（0.2.0 起，均可配置开关，默认全开）

| 层 | 机制 | 作用 |
|---|---|---|
| L2 | `tools/post-execute` 监听 | `pwsh` 工具结果出现 GBK 误解码/FFFD 洪水/中文变问号时，自动在结果后附加 `[windows-guard]` 修复提示（不中断、不改写结果本体） |
| L3 | `tools/pre-execute` 监听 | 拦截「不带 -Encoding 的 `Set-Content`/`Add-Content`/`Out-File` 写 JSON/YAML/TOML/GD」与「`>` 重定向写结构化文件」命令，deny 并给出 `[System.IO.File]::WriteAllText(...)` 正确写法 |
| L4 | `windows_encode_detect` / `windows_encode_fix` 工具 | 文件编码诊断（BOM/UTF-8/GBK/UTF-16 + 置信度）与修复（→ UTF-8 无 BOM，自动备份 `.windowsguard.bak`）；`dryRun` 只诊断不写入 |

> 历史：原 pwsh-guard 的 L1 系统提示词段**不再注入**——由上面的守则技能取代
> （按需加载、更省常驻 token）。

## 配置

`cordis.patch.yml` 全部可开关（默认全开）：

```yaml
- insert:
    - id: dsh-plugin-windows-guard
      name: dsh-plugin-windows-guard
      config:
        enabled: true     # 总开关（false = 只保留守则技能，退化为 0.1.0 纯守则形态）
        postCheck: true   # L2 pwsh 结果乱码检测+提示
        preCheck: true    # L3 危险写命令拦截
        detectTools: true # L4 编码诊断/修复工具
```

## 安装

```powershell
# 本地 link 开发（本仓库）：
git clone https://github.com/Pasumao/dsh-plugin-windows-guard.git D:\dsh\plugins\dsh-plugin-windows-guard
#   1. profile package.json dependencies 加
#      "dsh-plugin-windows-guard": "link:D:/dsh/plugins/dsh-plugin-windows-guard"
#   2. 加入 dsh.profile.bundles（或 cordis.patch.yml 手动 insert）
cd C:\Users\18303\.dsh\profiles\web
pnpm install
node D:\dsh\scripts\check-profile.mjs          # 自检 [PASS] 再重启
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dsh\scripts\restart-dsh.ps1

# npm 分发安装（发布后）：
npm install dsh-plugin-windows-guard --prefix C:\Users\18303\.dsh\profiles\web
# 并在 profile 包/补丁中挂载，其余同上
```

## 使用

安装后无需任何配置。模型遇到 Windows 命令/编码/乱码/路径/进程/端口任务时，
`skill({ name: "windows-enc" | "windows-sys" })` 自动加载对应守则；也可手动让模型
加载查看全文。

```text
用户：读一下 D:\dsh\config\comfy_prompt.json 看看配置
模型：读取前先按守则用 Get-Content -Encoding UTF8……
```

```text
用户：帮我修一下 config.json，JSON.parse 报错
模型：先 windows_encode_detect 查 config.json → "utf-8-bom（可信度 high）"
     → windows_encode_fix config.json → 已转换为 UTF-8 无 BOM（备份 .windowsguard.bak）
     → 验证 JSON 解析通过
```

```powershell
# 模型被告知（守则技能），且此类命令会被 L3 拦截并给出正确写法：
# Set-Content -Path data.json -Value $json      ← deny（PS5.1 写 UTF-16LE/BOM）
# [System.IO.File]::WriteAllText("data.json", $json, [System.Text.UTF8Encoding]::new($false))   ← 正确
```

### 为何拆成两个技能（设计说明）

- **常驻目录成本**：两条 description（~300 token）几乎不涨；
- **触发精度**：`windows-enc` 管「命令/文件内容出错」（编码/转义/乱码），
  `windows-sys` 管「系统环境排查」（路径/进程/端口/跨平台），边界清晰、互不牵连；
- **正文按需减半**：Windows「内容出错」类任务不再加载「系统环境」整章；
- 预留给未来主题（WSL/winget/容器…）归入 `windows-sys` 扩展。

## 实现说明

- 守则注册走 `ctx.skills.register`（官方 skill 子系统），content 为 SKILL.md 正文；
- L2/L3 走 `ctx.on('tools/post-execute' | 'tools/pre-execute')`；L4 走
  `ctx.tools.register`（原始 definition 形状）；不 import 任何 `@deepseek-ai/*`
  运行时包（link: realpath 解析，外部依赖从插件目录解析不到）；
- L2 只对工具名 `pwsh` 且成功结果生效；L3 仅拦截「确定会写坏」的窄模式，读操作与
  显式 `-Encoding` 的写操作放行；乱码词表基于历史会话实测（11/12 正/负例通过）；
- 依赖 `Node ≥22.5`（`TextDecoder('gbk')` 需要 full-icu，官方构建默认满足）；
- 技能正文/工具/守卫改动需重启 dsh（host 插件 apply 时读取 skills/ 目录）；
- 各层注册均有 ctx 能力守卫：任何一层不可用时降级并警告，绝不让插件挂载失败。

## 相关插件

已发布插件互相引用（更多 DSH 插件生态）：

- [dsh-plugin-workbench](https://www.npmjs.com/package/dsh-plugin-workbench) — VS Code 风格工作区文件浏览器 + 可编辑预览
- [dsh-notify](https://www.npmjs.com/package/dsh-notify) — agent 停止/出错的 Windows 原生通知 + 托盘图标
- [dsh-plugin-image-tools](https://www.npmjs.com/package/dsh-plugin-image-tools) — 图片选择卡 / 回复内嵌图片 / 聊天图片放大
- [dsh-plugin-dev-kb](https://www.npmjs.com/package/dsh-plugin-dev-kb) — dsh 官方文档完整 Markdown 镜像（插件开发知识库）
- [dsh-plugin-choice-refresh](https://www.npmjs.com/package/dsh-plugin-choice-refresh) — 选择卡「重新生成选项」/「更多选项」
- [dsh-plugin-table-zoom](https://www.npmjs.com/package/dsh-plugin-table-zoom) — 聊天表格浮窗查看 + 一键复制 Markdown
