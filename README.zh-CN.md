# pi-deepseek-v4-anchor

**[English](README.md) | [简体中文](README.zh-CN.md)**

pi 扩展：把 DeepSeek V4 Pro（及 Flash）的**首个模型请求锚定到 DSH Minimal 轨迹**（`We need` 起手思维链），首个持久工具调用后恢复完整工具目录。

这是 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的 pi 移植（实验证据见 [xiaobright/modeltest](https://github.com/xiaobright/modeltest)）。

> **状态：实验性。** 底层增益在单一私有评测（Project2，n=2）上测得，**不是**普适性能声明。请用自己的任务 A/B 验证。

## 为什么

DeepSeek V4 Pro 对 API 可见工具目录和系统提示词 persona 高度敏感：

| 配置 | Project2 Ability | 轨迹 |
|---|---:|---|
| Standard（全目录 + 完整提示词） | 91 / 92 | `Let me`（standard-like） |
| Minimal（两工具 + 一句话 persona） | 99 / 96 | `We need`（minimal-like） |
| **Anchored Standard（两阶段）** | **98 / 99** | 首轮 `We need`，之后全工具 |

两阶段做法：

1. **请求 #1（bootstrap）**：只暴露**真实 Minimal 工具对**（`bash` + `str_replace_editor`，schema 逐字节一致），系统提示词替换为 Minimal persona（`You are a helpful software engineer assistant.`）；不注入 AGENTS.md 摘要、技能目录提醒。
2. **晋升**：首个持久 `tool/call` 或 `assistant/message`（先到者）恢复全目录；persona 保持（DSH 验证配置），被剥离的 pi 上下文以 user message 注回，模型不丢 pi 规则。

## 特性

- **API 格式适配器**：请求管线先识别 provider payload 的 API 格式，再分流到对应适配器（`src/format.ts`）：
  `anthropic-messages`（system 为内容块数组、`tool_use` 块）或 `openai-chat`（字符串 / system 角色消息、`tool_calls`）。
  Minimal persona 替换在两种格式下都能生效 —— 此前在 anthropic-messages payload 下会静默不生效。
- **预设制**：`native` / `anchor`（默认）/ `anchor-restore` / `minimal`，日常只选 preset，高级键可覆盖。
- **`str_replace_editor`**：DSH Minimal 编辑器忠实移植（view/create/str_replace/insert、绝对路径、唯一匹配替换、16000 截断），**只在目标模型会话注册**。
- **Sticky promotion**：已晋升会话在压缩（历史折叠）后不再意外重锚定。
- **`bootstrapMaxTokens`**：首轮输出预算封顶（默认 1024；显式 `null` 关闭；晋升后剥离）。
- **模型限定**：只对 `models` 中的模型锚定；非目标模型看不到 `str_replace_editor`。
- **子代理**：`exemptSubagents: false`（默认）时子代理同样参与锚定（前提是 agent 类型加载了扩展）。
- **交互菜单**：`/anchored-tools` 弹出层级菜单（预设/高级/状态），带 Tab 补全。

## 安装

```bash
pi install npm:pi-deepseek-v4-anchor
# 或
pi install git:github.com/Sddft97/pi-deepseek-v4-anchor@v1.0.0
```

然后 `/reload`（或重启 pi）。默认预设 `anchor`，默认目标模型 `deepseek-v4-pro` / `deepseek-v4-flash`。

## 配置

配置在 `settings.json` 顶层 `anchoredTools` 键；全局 `~/.pi/agent/settings.json` 为基底，可信项目 `.pi/settings.json` 深合并覆盖（项目优先）。

```jsonc
"anchoredTools": {
  "enabled": true,
  "preset": "anchor",                 // "anchor" | "anchor-restore" | "minimal" | "native"
  "models": ["deepseek-v4-pro", "deepseek-v4-flash"],   // glob；"provider/modelId" 或裸名
  "exemptSubagents": false,           // false：子代理也参与锚定（默认）
  "locale": "zh",                     // UI 语言："en" | "zh"
  "notify": true,
  "debug": false,
  // 高级覆盖（一般不用动）：
  // "bootstrapTools": ["bash", "str_replace_editor"],
  // "bootstrapPrompt": "minimal",    // "minimal" | "trim" | "none"
  // "restorePrompt": false,          // 晋升后是否还原引导提示词
  // "contextReinject": true,         // 晋升后把剥离的 pi 上下文以 user message 注回
  // "promoteOn": "either",           // "tool-call" | "assistant-message" | "either" | "never"
  // "bootstrapMaxTokens": 1024       // 首轮输出预算封顶；显式 null 关闭
}
```

### 预设

| preset | 首轮 | 晋升后 | 适用 |
|---|---|---|---|
| `anchor`（默认） | minimal persona + `bash,str_replace_editor` | persona 保持 + pi 上下文注回 + 全目录 | 日常推荐（98/99 配置 + 能力保留） |
| `anchor-restore` | minimal persona + `bash,str_replace_editor` | 还原 pi 原提示词 + 全目录 | A/B：还原 vs 保持 |
| `minimal` | minimal persona + `bash,str_replace_editor` | **永不晋升**（全程两工具） | DSH Minimal 对照 |
| `native` | 不锚定 | — | 基线 / 临时关闭 |

## 运行时设置（`/anchored-tools`）

```
第 1 层：                     第 2 层（切换预设）：
┌ anchored-tools 设置 ─┐     anchor — 推荐：persona 保持 + 上下文注回
│ 🎯 切换预设          │     anchor-restore — 晋升后还原 pi 提示词
│ ⚙️ 高级设置          │     minimal — 永不晋升，全程两工具
│ 📋 状态详情          │     native — 关闭锚定，对照基线
└──────────────────────┘     🔙 返回上级

第 2 层（高级设置）→ 第 3 层：
🎛 目标模型（勾选 pro/flash，✅ 完成）
🤖 子代理豁免（开启/关闭）
🌐 语言（中文）
🔙 返回上级
```

导航：子菜单选"🔙 返回上级"或 Esc → 回上级；顶层 Esc 才退出。预设/目标模型/子代理豁免/语言修改**持久化**到 settings.json 并立即生效（UI 通过轻量字典本地化）。

## 验证

- 启动标记：`~/.pi/agent/tmp/anchored-loaded.log`
- 状态栏：引导期显示 `[⛓ bootstrap: bash+str_replace_editor]`
- 活动日志：`~/.pi/agent/tmp/anchored-activity.log`（每请求记录完整 session id、模型、工具名、决策）

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_ANCHORED=0` | 全局关闭 |
| `PI_ANCHORED_DEBUG=1` | 开启调试日志 |

## 开发

```sh
npm install
npm test          # node --test
npx tsc --noEmit  # 类型检查
```

## 更新日志

### v4.2 — 格式适配器 + anthropic-messages 修复

- **修复**：anthropic-messages payload（`system` 为内容块数组）下 Minimal persona 替换从不生效。现在先识别 payload 格式，再分流到格式专用适配器（`src/format.ts`），状态机（`index.ts`）与格式无关。
- **修复**：`promoteOn: "tool-call"` 现在能识别 anthropic 的 `tool_use` 内容块（此前只认 `tool_calls` / pi `toolCall`）。
- **修复**：上下文注回能捕获 `system` 数组里的原始提示词，不再只支持字符串 system。
- **修复**：日志自动创建 `~/.pi/agent/tmp/`，验证日志（启动标记 / 活动日志）真正可查。
- **重构**：单一 `index.ts` 拆分为 `src/` 模块（`config` / `format` / `promotion` / `editor` / `menu` / `log`）。

## 参考仓库

本项目借鉴了多个 MIT 许可上游的想法与代码：

| 仓库 | 作用 |
|---|---|
| [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | 本项目移植的 DSH anchored-standard 原版 preset（两阶段引导 + 晋升）。 |
| [xiaobright/modeltest](https://github.com/xiaobright/modeltest) | 私有 Project2 评测套件与 DeepSeek V4 Pro 工具目录条件化的实验证据。 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 官方 DeepSeek Harness；Minimal persona 与 `str_replace_editor` 工具 schema 的来源（此处逐字节一致）。 |
| [kxh4892636/pi-deepseek-anchor](https://github.com/kxh4892636/pi-deepseek-anchor) | 较早的 pi 移植；本项目的 `str_replace_editor` 实现改编自它。 |
| [vavilonska/SeekAnchor](https://github.com/vavilonska/SeekAnchor) | 多宿主（pi / omp / opencode）实现；另一个 `str_replace_editor` 参考。 |
| [Aurzex/omp-pi-anchored-standard](https://github.com/Aurzex/omp-pi-anchored-standard) | omp + pi 实现；配置/菜单思路（settings.json `anchoredTools`、预设）有参考。 |

许可归属见 [NOTICE](./NOTICE)。

## License

MIT。`str_replace_editor` 与锚定逻辑衍生自多个 MIT 上游——见 [NOTICE](./NOTICE)。
