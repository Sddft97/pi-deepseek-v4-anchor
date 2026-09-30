# pi-deepseek-v4-anchor

**为 [pi](https://github.com/earendil-works/pi-coding-agent) 中的 DeepSeek 模型提供两阶段工具引导：首个请求锚定在 Minimal 条件（两工具 + 一句话 persona——更便宜、轨迹更好），首个工具调用后恢复完整目录。**

[English](README.md) | [简体中文](README.zh-CN.md)

> **状态：实验性。** 增益数据来自单一私有基准，不是普适性能声明，请用自己的任务 A/B 验证。证据见[工作原理](docs/HOW_IT_WORKS.md)。

## 特性

- **两阶段锚定** —— 首请求只带 `bash` + `str_replace_editor` 和 DSH Minimal persona；首个持久工具调用恢复全目录（跨压缩保持）
- **成本控制** —— 首请求输出封顶（`bootstrapMaxTokens`，默认 1024），晋升后解除
- **模型限定** —— 精确 id / glob / `/正则/` 三种规则圈定目标；非目标模型完全不受影响，也看不到引导工具
- **运行时菜单** —— `/anchored-tools`：切预设、管理规则与单模型开关、查看实时状态，全部改动即时持久化到 `settings.json`
- **预设制** —— `anchor`（默认）/ `anchor-restore` / `minimal` / `native`，便于 A/B 对照
- **API 格式适配** —— `anthropic-messages` 与 `openai-chat` 两种 payload 格式都支持
- **子代理感知** —— 子代理与主会话同样参与锚定（`exemptSubagents` 可关）
- **双语界面** —— 菜单支持中文/English（`locale`）

## 安装

```bash
pi install npm:pi-deepseek-v4-anchor
```

然后 `/reload`（或重启 pi）。

## 快速开始

开箱即用：默认规则 `/deepseek.*(flash|pro)/i` 锚定所有 DeepSeek flash/pro 模型（任意 provider、任意命名）：

1. 用此类模型开会话，状态栏出现 `[⛓ bootstrap: bash+str_replace_editor]`
2. 第一轮以 Minimal 工具对 + persona、受限输出预算运行
3. 首个工具调用即晋升——恢复全目录、解除封顶、清除状态

查看当前锚定情况：`/anchored-tools` → 📋 状态详情。调整范围：`/anchored-tools` → ⚙️ 高级设置 → 🎛 目标模型。

## 菜单参考（`/anchored-tools`）

**目标模型**界面用两个正交指示器——勾选框回答"我是否手动开启了它"，📜 后缀回答"是否有规则覆盖它"：

```
── 匹配规则 ──
☑ 📜 /deepseek.*(flash|pro)/i（命中 4）   ← 点击 = 编辑 / 停用 / 删除
⏸ 📜 /deepseek-r1/（已停用）                ← 点击 = 编辑 / 启用 / 删除
➕ 添加规则（glob 或 /正则/flags）
── 模型 ──
☑ 📜 bai/deepseek-v4-flash          手动开 + 规则覆盖
☑ opencode/deepseek-v3              仅手动开
☐ 📜 openrouter/deepseek/deepseek-r1  仅规则覆盖（仍会被锚定！）
☐ someprovider/deepseek-v2          未启用
```

- 实际生效 = **勾选框 ∨ 📜**；标题显示"生效 N/M"
- 点击模型 = 切换一条 **provider 限定精确条目**（`provider/modelId`），绝不产生通配
- 规则：✏️ 编辑（输入弹窗）/ ⏸ 停用（存入 `disabledModels`，可一键恢复、不参与匹配）/ 🗑 删除；➕ 添加规则接受任意模式，输入停用区已有的规则会直接启用
- 重复与非法正则会被拒绝；始终强制至少保留一个生效条目
- 模型列表来自实时注册表：DeepSeek 系 ∪ 被任一生效规则命中——DeepSeek 新模型自动出现

其余菜单项：🎯 切换预设、🤖 子代理豁免、🌐 语言、📋 状态详情。子菜单 Esc/返回回上级；改动即时持久化。

## 配置

`settings.json`（全局 `~/.pi/agent/settings.json` 为基底，可信项目 `.pi/settings.json` 深合并覆盖；数组整体替换）：

```jsonc
"anchoredTools": {
  "enabled": true,
  "preset": "anchor",                       // "anchor" | "anchor-restore" | "minimal" | "native"
  "models": ["/deepseek.*(flash|pro)/i"],   // 模式：glob 或 /正则/flags（见下）
  "disabledModels": [],                     // 菜单停用的规则暂存；不参与匹配
  "exemptSubagents": false,                 // false：子代理也参与锚定
  "locale": "zh",                           // "en" | "zh"
  "notify": true,
  "debug": false
  // 高级键（一般不用动）："bootstrapTools"、"bootstrapPrompt"、"restorePrompt"、
  // "contextReinject"、"promoteOn"、"bootstrapMaxTokens"（null 关闭封顶）
}
```

除高级键外，以上全部可在菜单里管理。

### 匹配规则：glob 与正则

`models` 条目的类型**由写法推导**；正则与 glob 的锚定方式和测试对象不同：

| | glob（其他写法） | 正则（写成 `/模式/flags`） |
|---|---|---|
| 匹配方式 | **整串全匹配**（自动锚定 `^…$`） | **子串匹配**（不锚定） |
| 通配 | 只有 `*` 和 `?`，其余全是字面量 | 完整 JavaScript 正则 |
| 测试对象 | 含 `/` → 仅 `provider/modelId`；不含 → 仅裸 id | 裸 id 与 `provider/modelId` **都测**（任一命中即算） |

常见意外：

- `/^deepseek.*/` 会命中**整个 DeepSeek 家族**——所有 DeepSeek id 都以 `deepseek` 开头。想圈子集用 `/^deepseek-v4/` 这类
- 正则的 `.` 是任意字符：匹配字面点号要写 `\.`（JSON 里写 `\\.`）；精确匹配要自己锚定 `/^deepseek-v4-flash$/`
- 不带斜杠是 **glob 不是正则**：`deepseek.*flash` 要求 id 里有字面 `.`，正则语法只在 `/…/` 内生效
- glob 是全匹配："包含 flash" 要写 `*flash*`，不是 `flash`
- 裸 id glob（`deepseek-v4-flash`）跨 provider 生效；限定单个 provider 用 `provider/modelId`

示例：

```jsonc
"models": [
  "/deepseek.*flash/i",              // 任意 provider、任意 flash 命名
  "/^commandcode\\/deepseek-v4/",    // 锚定 qualified 形式：限定 provider
  "*deepseek-v4*",                   // glob：pro + flash + 变体
  "commandcode/deepseek-v4-pro"      // 精确、provider 限定
]
```

匹配器每请求重新求值——新模型只需改一行配置（或点一下菜单），无需改代码。

### 预设

| preset | 首轮 | 晋升后 | 适用 |
|---|---|---|---|
| `anchor`（默认） | Minimal 对 + persona | persona 保持 + pi 上下文注回 + 全目录 | 日常 |
| `anchor-restore` | Minimal 对 + persona | 还原 pi 原提示词 + 全目录 | A/B：还原 vs 保持 |
| `minimal` | Minimal 对 + persona | **永不晋升** | DSH Minimal 对照 |
| `native` | 不锚定 | — | 基线 / 临时关闭 |

### 子代理

`exemptSubagents: false`（默认）时子代理与主会话同样参与锚定。前提是该 agent 类型加载扩展——agent 配置里 `extensions: false` 的子代理不会运行本扩展；需要锚定就在 agent 定义里设为 `true`。

## 验证是否生效

- **状态栏**：引导期显示 `[⛓ bootstrap: …]`，晋升后清除
- **`/anchored-tools` → 📋 状态详情**：预设、生效模式、当前模型、是否命中、所处阶段
- **日志**：`~/.pi/agent/tmp/anchored-loaded.log`（每次加载一行——版本核对入口）、`anchored-activity.log`（每请求决策）、`"debug": true` 时另有 `anchored-debug.log`

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_ANCHORED=0` | 全局关闭，不改配置 |
| `PI_ANCHORED_DEBUG=1` | 开启调试日志 |

## 更新日志 · 贡献 · 内部机制

- [CHANGELOG](CHANGELOG.md) —— 版本历史
- [CONTRIBUTING](CONTRIBUTING.md) —— 开发环境、分支流程、发版流程（英文）
- [工作原理](docs/HOW_IT_WORKS.md) —— 证据、状态机、模块地图、上游谱系（英文）

## License

MIT。`str_replace_editor` 与锚定思路衍生自多个 MIT 上游——见 [NOTICE](NOTICE)。
