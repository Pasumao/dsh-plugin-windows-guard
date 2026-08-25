# Changelog

## [0.1.0] - 2026-08-25

- 首发 `dsh-plugin-windows-guard`：Windows 环境防坑守则 skill 插件（纯数据）。
- 内容来源：本机 255 个会话归档问题扫描（GBK 误解码 / BOM / UTF-16 /
  单引号转义 / 长路径 / EACCES / 端口占用 / stderr 误判 / 乱码当答案）。
- 按触发场景拆为两个技能：
  - `windows-enc`：编码与 PowerShell 解析守则（读/写文件、引号转义、乱码三不）；
  - `windows-sys`：系统环境守则（路径/文件占用、进程与端口、跨平台杂项）。
- 纯技能载体：`lib/index.js` 约 40 行注册代码；零运行时依赖、零构建。
