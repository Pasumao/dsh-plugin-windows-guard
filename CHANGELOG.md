# Changelog

## [0.2.2] - 2026-09-10

- 修复：L3 重定向拦截对命令中部 `> file.json` 的漏放（锚点逻辑缺口），现覆盖任意位置的 `>` 重定向写结构化文件；
- 修复：`windows_encode_fix` 对「UTF-8 BOM 存在但主体非合法 UTF-8」的文件改报明确的「无法判定编码」错误，不再走崩溃报错路径；
- 修复：移除对 `.gd`（Godot）扩展名的误拦截；
- 自检：selfcheck 版本断言改为通用格式校验（不再硬编码具体版本号）；
- 文档：README 同步拦截能力与工具行为描述；相关插件表格修复断行。

## [0.2.1] - 2026-08-29

- 文档：首屏前置「255 个真实会话」钩子；安装节改为单行 dsh plugin add 命令并去掉作者本机绝对路径；新增「装完你会看到什么」与徽章行；
- 元数据：keywords 补长尾词（mojibake/write-guard 等，15 → 20）；
- 新增英文版 README.en.md 与双语切换行。
## [0.2.0] - 2026-08-29

- **合并 `dsh-plugin-pwsh-guard` 全部主动防护能力（该插件同日删除，本插件为唯一后继）**：
  - L2 `tools/post-execute`：pwsh 工具结果出现 GBK 误解码 / U+FFFD 洪水 / ASCII 化
    乱码时，自动附加 `[windows-guard]` 修复提示（不中断、不改写结果本体）；
  - L3 `tools/pre-execute`：拦截「无 `-Encoding` 的 `Set-Content`/`Add-Content`/
    `Out-File` 写 JSON/YAML/TOML/GD」与「`>` 重定向写结构化文件」，deny 并给出
    `WriteAllText` 正确写法；
  - L4 新工具 `windows_encode_detect` / `windows_encode_fix`（原 `ps_encode_*`
    更名，遵循「主题_动词」工具命名规范）：编码诊断（BOM/UTF-8/GBK/UTF-16 +
    置信度）与修复（→ UTF-8 无 BOM，备份 `<path>.windowsguard.bak`，支持 dryRun）。
- 原 pwsh-guard 的 L1 系统提示词段**不再注入**——由 0.1.0 的守则技能取代
  （按需加载、更省常驻 token）。
- 配置开关（cordis.patch.yml，默认全开）：`enabled` / `postCheck` / `preCheck` /
  `detectTools`；`enabled: false` 时退化为 0.1.0 的纯守则形态。
- `inject` 从 `['skills']` 扩为 `['skills', 'tools']`；版本 0.1.0 → 0.2.0。

## [0.1.0] - 2026-08-25

- 首发 `dsh-plugin-windows-guard`：Windows 环境防坑守则 skill 插件（纯数据）。
- 内容来源：本机 255 个会话归档问题扫描（GBK 误解码 / BOM / UTF-16 /
  单引号转义 / 长路径 / EACCES / 端口占用 / stderr 误判 / 乱码当答案）。
- 按触发场景拆为两个技能：
  - `windows-enc`：编码与 PowerShell 解析守则（读/写文件、引号转义、乱码三不）；
  - `windows-sys`：系统环境守则（路径/文件占用、进程与端口、跨平台杂项）。
- 纯技能载体：`lib/index.js` 约 40 行注册代码；零运行时依赖、零构建。
