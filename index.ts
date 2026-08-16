/**
 * anchored-standard for pi — DeepSeek V4 Pro two-phase tool bootstrap (v4.1)
 *
 * Port of https://github.com/xiaobright/dsh-anchored-standard (evidence in
 * https://github.com/xiaobright/modeltest):
 *   DeepSeek V4 Pro conditions strongly on the API-visible tool catalog and
 *   the system-prompt persona:
 *   - Standard full catalog + full prompt → 91/92 (Project2)
 *   - Minimal two tools + one-line persona → 99/96
 *   - Two-phase: anchor the first request on the Minimal condition, restore
 *     the full catalog after the first durable tool call → 98/99
 *
 * v4.1 features:
 *   - Config lives in settings.json under the top-level "anchoredTools" key:
 *     global ~/.pi/agent/settings.json is the base; a trusted project's
 *     .pi/settings.json deep-merges over it (nested objects recurse, arrays
 *     replace, project wins).
 *   - Presets: native / anchor (default) / anchor-restore / minimal. Pick one
 *     in normal use; advanced keys override it.
 *   - Bootstrap pair: bash + str_replace_editor (the real Minimal pair, issue
 *     #11: bash+read is standard-like 11/11, the Minimal pair anchors 5/5).
 *   - promoteOn: "tool-call" | "assistant-message" | "either" (default) | "never".
 *   - bootstrapMaxTokens: first-request output cap (default 1024; explicit
 *     null disables; the injected cap is stripped after promotion).
 *   - restorePrompt / contextReinject / exemptSubagents / notify / debug.
 *   - Sticky promotion: once promoted, the session stays promoted across
 *     compaction (history collapse no longer re-anchors).
 *   - str_replace_editor is registered only for target-model sessions and is
 *     stripped for non-target models.
 *   - /anchored-tools: interactive hierarchical menu (preset / advanced /
 *     status) with Tab completion.
 *
 * Config example (settings.json):
 *   "anchoredTools": {
 *     "enabled": true,
 *     "preset": "anchor",
 *     "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
 *     "exemptSubagents": false,
 *     "notify": true,
 *     "debug": false
 *   }
 *
 * Quick env switches: PI_ANCHORED=0 disables globally; PI_ANCHORED_DEBUG=1
 * writes debug logs.
 *
 * Disclaimer: the gain was measured on the DSH harness + Project2 single
 * benchmark (n=2); the authors explicitly disclaim cross-task/cross-channel
 * universality. Verify with your own A/B tests on pi + relay.
 */
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";

// ────────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────────

/** DSH minimal preset 的完整 persona（逐字节一致，不得改写）。 */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

const DEFAULT_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
const DEFAULT_BOOTSTRAP_TOOLS = ["bash", "str_replace_editor"];

/** DSH Minimal str_replace_editor 工具描述（与官方 preset 逐字节一致，不得改写）。 */
const EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

const EDITOR_TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

const MARKER_PATH = join(homedir(), ".pi", "agent", "tmp", "anchored-loaded.log");
const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "tmp", "anchored-debug.log");
/** 无条件活动日志：每个请求的决策 + 异常，用于排查“为什么没生效”。 */
const ACTIVITY_LOG_PATH = join(homedir(), ".pi", "agent", "tmp", "anchored-activity.log");

const MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;

const PROMPT_MARKERS = {
	start: "Available tools:",
	end: "In addition to the tools above",
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 类型与配置
// ────────────────────────────────────────────────────────────────────────────

export type PromoteOn = "tool-call" | "assistant-message" | "either" | "never";
export type BootstrapPrompt = "minimal" | "trim" | "none";
export type PresetName = "native" | "anchor" | "anchor-restore" | "minimal";

/**
 * 预设定义。日常只选 preset，高级项才单独覆盖。
 * - native:          完全不锚定（对照基线 / 临时关闭）
 * - anchor:          两阶段锚定；晋升后 persona 永久 + pi 上下文以 user message 注回（98/99 配置 + 能力保留）
 * - anchor-restore:  两阶段锚定；晋升后还原 pi 原提示词（不注回）
 * - minimal:         永久 minimal（两工具 + persona，不晋升）—— DSH Minimal 模式
 */
export interface PresetDef {
	enabled: boolean;
	bootstrapTools: string[];
	bootstrapPrompt: BootstrapPrompt;
	restorePrompt: boolean;
	promoteOn: PromoteOn;
	contextReinject: boolean;
	exemptSubagents: boolean;
	bootstrapMaxTokens: number | undefined;
}

export const PRESETS: Record<PresetName, PresetDef> = {
		native: {
		enabled: false,
		bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
		bootstrapPrompt: "minimal",
		restorePrompt: false,
		promoteOn: "either",
		contextReinject: true,
		exemptSubagents: false,
		bootstrapMaxTokens: 1024,
	},
	anchor: {
		enabled: true,
		bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
		bootstrapPrompt: "minimal",
		restorePrompt: false,
		promoteOn: "either",
		contextReinject: true,
		exemptSubagents: false,
		bootstrapMaxTokens: 1024,
	},
	"anchor-restore": {
		enabled: true,
		bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
		bootstrapPrompt: "minimal",
		restorePrompt: true,
		promoteOn: "either",
		contextReinject: false,
		exemptSubagents: false,
		bootstrapMaxTokens: 1024,
	},
	minimal: {
		enabled: true,
		bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
		bootstrapPrompt: "minimal",
		restorePrompt: false,
		promoteOn: "never",
		contextReinject: false,
		exemptSubagents: false,
		bootstrapMaxTokens: 1024,
	},
};

export interface Config extends PresetDef {
	preset: PresetName;
	models: string[];
	/** UI language: "en" | "zh". */
	locale: Locale;
	notify: boolean;
	debug: boolean;
}

interface RawAnchoredTools {
	enabled?: unknown;
	preset?: unknown;
	models?: unknown;
	bootstrapTools?: unknown;
	bootstrapPrompt?: unknown;
	promoteOn?: unknown;
	bootstrapMaxTokens?: unknown;
	restorePrompt?: unknown;
	/** 晋升后（保留 persona 时）把被剥离的 pi 上下文以 user message 注回。 */
	contextReinject?: unknown;
	exemptSubagents?: unknown;
	locale?: unknown;
	notify?: unknown;
	debug?: unknown;
}

export function isPresetName(v: unknown): v is PresetName {
	return v === "native" || v === "anchor" || v === "anchor-restore" || v === "minimal";
}

export function isPromoteOn(v: unknown): v is PromoteOn {
	return v === "tool-call" || v === "assistant-message" || v === "either" || v === "never";
}

export function isBootstrapPrompt(v: unknown): v is BootstrapPrompt {
	return v === "minimal" || v === "trim" || v === "none";
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envBool(name: string, def: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return def;
	return !/^(0|false|no|off)$/i.test(raw.trim());
}

/** 嵌套对象递归合并；数组与标量整体替换；override 未定义时保留 base。 */
export function deepMerge(base: unknown, override: unknown): unknown {
	if (isPlainObject(base) && isPlainObject(override)) {
		const out: Record<string, unknown> = { ...base };
		for (const [k, v] of Object.entries(override)) {
			out[k] = k in out ? deepMerge(out[k], v) : v;
		}
		return out;
	}
	return override === undefined ? base : override;
}

function readSettingsJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(parsed) ? parsed : undefined;
	} catch (err) {
		console.warn(`[anchored-tools] failed to parse ${path}: ${(err as Error).message}; ignoring`);
		return undefined;
	}
}

/** 从 settings.json 读取并深合并全局 + 项目配置。 */
export function loadRawConfig(cwd: string, projectTrusted: boolean): RawAnchoredTools | undefined {
	const globalRaw = readSettingsJson(join(getAgentDir(), "settings.json"))?.anchoredTools as RawAnchoredTools | undefined;
	let merged = globalRaw;
	if (projectTrusted) {
		const projectRaw = readSettingsJson(join(cwd, CONFIG_DIR_NAME, "settings.json"))?.anchoredTools as RawAnchoredTools | undefined;
		if (projectRaw !== undefined) merged = deepMerge(globalRaw, projectRaw) as RawAnchoredTools;
	}
	return merged;
}

/** 校验 + 默认值。preset 提供基底，显式键覆盖（高级用法）。 */
export function resolveConfig(raw: RawAnchoredTools | undefined): Config {
	const r = raw ?? {};
	const preset: PresetName = isPresetName(r.preset) ? r.preset : "anchor";
	const base = PRESETS[preset];
	return {
		enabled: r.enabled !== undefined ? Boolean(r.enabled) : base.enabled,
		preset,
		models:
			Array.isArray(r.models) && r.models.every((m) => typeof m === "string") && r.models.length > 0
				? (r.models as string[])
				: [...DEFAULT_MODELS],
		bootstrapTools:
			Array.isArray(r.bootstrapTools) &&
			r.bootstrapTools.every((t) => typeof t === "string") &&
			r.bootstrapTools.length > 0
				? [...new Set(r.bootstrapTools as string[])]
				: [...base.bootstrapTools],
		bootstrapPrompt: isBootstrapPrompt(r.bootstrapPrompt) ? r.bootstrapPrompt : base.bootstrapPrompt,
		restorePrompt: r.restorePrompt !== undefined ? Boolean(r.restorePrompt) : base.restorePrompt,
		promoteOn: isPromoteOn(r.promoteOn) ? r.promoteOn : base.promoteOn,
		contextReinject: r.contextReinject !== undefined ? Boolean(r.contextReinject) : base.contextReinject,
		exemptSubagents: r.exemptSubagents !== undefined ? Boolean(r.exemptSubagents) : base.exemptSubagents,
		locale: r.locale === "en" || r.locale === "zh" ? r.locale : "en",
		bootstrapMaxTokens: isPositiveInt(r.bootstrapMaxTokens)
			? r.bootstrapMaxTokens
			: r.bootstrapMaxTokens === null
				? undefined // 显式 null = 关闭封顶
				: base.bootstrapMaxTokens,
		notify: r.notify !== undefined ? Boolean(r.notify) : true,
		debug: r.debug !== undefined ? Boolean(r.debug) : envBool("PI_ANCHORED_DEBUG", false),
	};
}

// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// i18n（轻量字典，无外部依赖）
// ────────────────────────────────────────────────────────────────────────────

export type Locale = "en" | "zh";

const I18N = {
	en: {
		topTitle: (preset: string, phase: string) => `anchored-tools settings — current: ${preset} / ${phase}`,
		switchPreset: "🎯 Switch preset",
		advanced: "⚙️ Advanced settings",
		status: "📋 Status",
		presetTitle: (preset: string) => `Select preset (current: ${preset}) — persisted to settings.json, active immediately`,
		presetAnchor: "anchor — recommended: persona stays + context reinjected",
		presetAnchorRestore: "anchor-restore — restore original pi prompt after promotion",
		presetMinimal: "minimal — never promotes, two tools only",
		presetNative: "native — no anchoring (baseline)",
		currentSuffix: " (current)",
		advancedTitle: (preset: string) => `Advanced settings (preset: ${preset})`,
		targetModels: (models: string) => `🎛 Target models (${models})`,
		subagentExemption: (state: string) => `🤖 Subagent exemption (${state})`,
		language: (name: string) => `🌐 Language (${name})`,
		back: "🔙 Back",
		modelsTitle: (models: string) => `Target models (current: ${models})`,
		modelToggle: (name: string, on: boolean) => `${on ? "☑" : "☐"} ${name} (toggle)`,
		done: "✅ Done",
		atLeastOneModel: "[anchored-tools] at least one target model is required",
		modelsPersisted: (models: string) => `[anchored-tools] models → ${models} (persisted)`,
		exemptionTitle: (state: string) => `Subagent exemption (current: ${state})`,
		exemptionEnabled: "✅ Enabled — subagents skip bootstrap, full catalog always",
		exemptionDisabled: "❌ Disabled — subagents bootstrap like the main session",
		exemptionPersisted: (value: boolean) => `[anchored-tools] exemptSubagents → ${value} (persisted)`,
		languageTitle: (current: string) => `Language (current: ${current})`,
		languageEn: "English",
		languageZh: "中文",
		languagePersisted: (locale: string) => `[anchored-tools] locale → ${locale} (persisted)`,
		writeFailed: (path: string) => `[anchored-tools] failed to write settings.json: ${path}`,
		writeError: (msg: string) => `[anchored-tools] write failed: ${msg}`,
		presetPersisted: (preset: string) => `[anchored-tools] preset → ${preset} (persisted, active immediately)`,
		usage: "Usage: /anchored-tools preset <anchor|anchor-restore|minimal|native>",
		error: (msg: string) => `[anchored-tools] error: ${msg}`,
		statusPreset: (v: string) => `preset: ${v}`,
		statusEnabled: (v: boolean) => `enabled: ${v}`,
		statusPromoteOn: (v: string) => `promote on: ${v}`,
		statusPrompt: (p: string, r: boolean, c: boolean) => `bootstrap prompt: ${p} (restore: ${r}, reinject: ${c})`,
		statusTools: (v: string) => `bootstrap tools: ${v}`,
		statusMaxTokens: (v: string) => `bootstrap max tokens: ${v}`,
		statusExempt: (v: boolean) => `exempt subagents: ${v}`,
		statusModels: (v: string) => `target models: ${v}`,
		statusModel: (v: string) => `current model: ${v}`,
		statusMatched: (v: string) => `model matched: ${v}`,
		statusPhase: (v: string) => `phase: ${v}`,
		phaseDisabled: "disabled",
		phaseNotTargeted: "not-targeted",
		phasePromoted: "promoted (full catalog)",
		phaseBootstrap: (tools: string) => `bootstrap (${tools} only)`,
		offDefault: "off (default)",
		none: "(none)",
		yes: "yes",
		no: "no",
		nA: "n/a",
		enabled: "enabled",
		disabled: "disabled",
	},
	zh: {
		topTitle: (preset: string, phase: string) => `anchored-tools 设置 — 当前: ${preset} / ${phase}`,
		switchPreset: "🎯 切换预设",
		advanced: "⚙️ 高级设置",
		status: "📋 状态详情",
		presetTitle: (preset: string) => `选择预设（当前: ${preset}） — 持久化到 settings.json，立即生效`,
		presetAnchor: "anchor — 推荐：persona 保持 + 上下文注回",
		presetAnchorRestore: "anchor-restore — 晋升后还原 pi 提示词",
		presetMinimal: "minimal — 永不晋升，全程两工具",
		presetNative: "native — 关闭锚定，对照基线",
		currentSuffix: "（当前）",
		advancedTitle: (preset: string) => `高级设置（预设: ${preset}）`,
		targetModels: (models: string) => `🎛 目标模型（${models}）`,
		subagentExemption: (state: string) => `🤖 子代理豁免（${state}）`,
		language: (name: string) => `🌐 语言（${name}）`,
		back: "🔙 返回上级",
		modelsTitle: (models: string) => `目标模型（当前: ${models}）`,
		modelToggle: (name: string, on: boolean) => `${on ? "☑" : "☐"} ${name}（点击切换）`,
		done: "✅ 完成",
		atLeastOneModel: "[anchored-tools] 至少保留一个目标模型",
		modelsPersisted: (models: string) => `[anchored-tools] models → ${models}（已持久化）`,
		exemptionTitle: (state: string) => `子代理豁免（当前: ${state}）`,
		exemptionEnabled: "✅ 开启 — 子代理跳过预热，始终全目录",
		exemptionDisabled: "❌ 关闭 — 子代理也各自预热",
		exemptionPersisted: (value: boolean) => `[anchored-tools] exemptSubagents → ${value}（已持久化）`,
		languageTitle: (current: string) => `语言（当前: ${current}）`,
		languageEn: "English",
		languageZh: "中文",
		languagePersisted: (locale: string) => `[anchored-tools] locale → ${locale}（已持久化）`,
		writeFailed: (path: string) => `[anchored-tools] 无法写入 settings.json: ${path}`,
		writeError: (msg: string) => `[anchored-tools] 写入失败: ${msg}`,
		presetPersisted: (preset: string) => `[anchored-tools] preset → ${preset}（已持久化，立即生效）`,
		usage: "用法: /anchored-tools preset <anchor|anchor-restore|minimal|native>",
		error: (msg: string) => `[anchored-tools] 错误: ${msg}`,
		statusPreset: (v: string) => `preset: ${v}`,
		statusEnabled: (v: boolean) => `enabled: ${v}`,
		statusPromoteOn: (v: string) => `promote on: ${v}`,
		statusPrompt: (p: string, r: boolean, c: boolean) => `bootstrap prompt: ${p} (restore: ${r}, reinject: ${c})`,
		statusTools: (v: string) => `bootstrap tools: ${v}`,
		statusMaxTokens: (v: string) => `bootstrap max tokens: ${v}`,
		statusExempt: (v: boolean) => `exempt subagents: ${v}`,
		statusModels: (v: string) => `target models: ${v}`,
		statusModel: (v: string) => `current model: ${v}`,
		statusMatched: (v: string) => `model matched: ${v}`,
		statusPhase: (v: string) => `phase: ${v}`,
		phaseDisabled: "disabled",
		phaseNotTargeted: "not-targeted",
		phasePromoted: "promoted (full catalog)",
		phaseBootstrap: (tools: string) => `bootstrap (${tools} only)`,
		offDefault: "off (default)",
		none: "(无)",
		yes: "是",
		no: "否",
		nA: "n/a",
		enabled: "开启",
		disabled: "关闭",
	},
} as const;

type I18nKey = keyof typeof I18N.en;

function makeT(locale: Locale) {
	const dict = I18N[locale] ?? I18N.en;
	return (key: I18nKey, ...args: unknown[]): string => {
		const v = dict[key] as unknown;
		return typeof v === "function" ? (v as (...a: unknown[]) => string)(...args) : (v as string);
	};
}

// 模型匹配（glob）
// ────────────────────────────────────────────────────────────────────────────

export function matchGlob(pattern: string, value: string): boolean {
	const regex = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".") +
			"$",
	);
	return regex.test(value);
}

export function modelMatches(modelId: string, provider: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const qualified = `${provider}/${modelId}`;
	return patterns.some((p) =>
		p.includes("/") ? matchGlob(p, qualified) : matchGlob(p, qualified) || matchGlob(p, modelId),
	);
}

// ────────────────────────────────────────────────────────────────────────────
// 晋升判定（provider payload 格式 / 会话条目格式）
// ────────────────────────────────────────────────────────────────────────────

type PayloadMessage = { role?: string; tool_calls?: unknown; content?: unknown };

/** provider payload 历史：assistant 的 tool_calls 字段、role=tool 结果、或 toolCall 内容块。 */
export function hasToolCallHistory(messages: unknown[]): boolean {
	return (messages ?? []).some((raw) => {
		const m = raw as PayloadMessage;
		if (!m || typeof m !== "object") return false;
		if (m.role === "tool") return true;
		if (m.role === "assistant") {
			if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
			if (Array.isArray(m.content)) {
				return m.content.some(
					(c) => c && typeof c === "object" && (c as { type?: string }).type === "toolCall",
				);
			}
		}
		return false;
	});
}

export function hasAssistantMessage(messages: unknown[]): boolean {
	return (messages ?? []).some((m) => (m as PayloadMessage)?.role === "assistant");
}

export function isPromoted(messages: unknown[], promoteOn: PromoteOn): boolean {
	if (promoteOn === "never") return false; // 永不晋升（minimal 预设）
	if (promoteOn === "tool-call") return hasToolCallHistory(messages);
	if (promoteOn === "assistant-message") return hasAssistantMessage(messages);
	return hasToolCallHistory(messages) || hasAssistantMessage(messages);
}

/** 会话条目（buildContextEntries）格式：role=toolResult 或 content 里 type=toolCall。 */
export function hasToolCallHistoryEntries(entries: unknown[]): boolean {
	return (entries ?? []).some((e) => {
		const m = (e as { message?: { role?: string; content?: unknown[] } })?.message;
		if (!m) return false;
		if (m.role === "toolResult") return true;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return m.content.some(
				(c) => c && typeof c === "object" && (c as { type?: string }).type === "toolCall",
			);
		}
		return false;
	});
}

export function isPromotedEntries(entries: unknown[], promoteOn: PromoteOn): boolean {
	if (promoteOn === "never") return false;
	if (promoteOn === "tool-call") return hasToolCallHistoryEntries(entries);
	if (promoteOn === "assistant-message") {
		return (entries ?? []).some((e) => (e as { message?: { role?: string } })?.message?.role === "assistant");
	}
	return (
		hasToolCallHistoryEntries(entries) ||
		(entries ?? []).some((e) => (e as { message?: { role?: string } })?.message?.role === "assistant")
	);
}

// ────────────────────────────────────────────────────────────────────────────
// 系统提示词改写
// ────────────────────────────────────────────────────────────────────────────

/** 找到 messages 里第一个 system/developer 消息。 */
function findSystemMessage(
	messages: unknown[],
): { msg: { content?: unknown }; index: number } | undefined {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as PayloadMessage | null;
		if (m && typeof m === "object" && (m.role === "system" || m.role === "developer")) {
			return { msg: m as { content?: unknown }, index: i };
		}
	}
	return undefined;
}

/** 把系统提示词整体替换为给定文本（处理 payload.system 或 messages[0..n] 的 system 消息）。 */
export function rewriteSystemPrompt(
	payload: Record<string, unknown>,
	text: string,
): { changed: boolean; payload: Record<string, unknown> } {
	if (typeof payload.system === "string" && payload.system !== text) {
		return { changed: true, payload: { ...payload, system: text } };
	}
	const messages = payload.messages;
	if (!Array.isArray(messages)) return { changed: false, payload };
	const found = findSystemMessage(messages);
	if (!found) return { changed: false, payload };
	if (typeof found.msg.content === "string" && found.msg.content === text) {
		return { changed: false, payload };
	}
	const next = messages.slice();
	next[found.index] = { ...(messages[found.index] as object), content: text };
	return { changed: true, payload: { ...payload, messages: next } };
}

/** 把系统提示词里 "Available tools:" 清单裁剪为只保留引导工具（保留原 snippet）。 */
export function trimSystemPrompt(text: string, keepTools: string[]): string {
	if (typeof text !== "string") return text;
	const startIdx = text.indexOf(PROMPT_MARKERS.start);
	const endIdx = text.indexOf(PROMPT_MARKERS.end);
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return text; // 找不到标记，安全降级

	const listSection = text.slice(startIdx + PROMPT_MARKERS.start.length, endIdx);
	const keptLines: string[] = [];
	for (const name of keepTools) {
		const lineMatch = listSection.match(new RegExp(`^\\s*- ${name}: .*$`, "m"));
		keptLines.push(lineMatch ? lineMatch[0].trim() : `- ${name}: available`);
	}
	return (
		text.slice(0, startIdx) +
		PROMPT_MARKERS.start +
		"\n" +
		keptLines.join("\n") +
		"\n\n" +
		text.slice(endIdx)
	);
}

/** 按 bootstrapPrompt 模式改写 payload 里的系统提示词。 */
export function applyPromptMode(
	payload: Record<string, unknown>,
	mode: BootstrapPrompt,
	keepTools: string[],
): { changed: boolean; payload: Record<string, unknown> } {
	if (mode === "none") return { changed: false, payload };
	if (mode === "minimal") return rewriteSystemPrompt(payload, MINIMAL_SYSTEM_PROMPT);

	// trim：只改 messages 里 system 消息的内容
	const messages = payload.messages;
	if (!Array.isArray(messages)) return { changed: false, payload };
	const found = findSystemMessage(messages);
	if (!found) return { changed: false, payload };
	if (typeof found.msg.content !== "string") return { changed: false, payload };
	const trimmed = trimSystemPrompt(found.msg.content, keepTools);
	if (trimmed === found.msg.content) return { changed: false, payload };
	const next = messages.slice();
	next[found.index] = { ...(messages[found.index] as object), content: trimmed };
	return { changed: true, payload: { ...payload, messages: next } };
}

// ────────────────────────────────────────────────────────────────────────────
// str_replace_editor（DSH Minimal 编辑器工具，pi 移植自 pi-deepseek-anchor / SeekAnchor）
// ────────────────────────────────────────────────────────────────────────────

interface EditorArgs {
	command: "view" | "create" | "str_replace" | "insert";
	path: string;
	file_text?: string;
	insert_line?: number;
	new_str?: string;
	old_str?: string;
	view_range?: number[];
}

const EDITOR_MAX_OUTPUT_CHARS = 16000;

function editorTruncate(content: string, maxOutputChars: number): string {
	return content.length <= maxOutputChars
		? content
		: content.slice(0, maxOutputChars) + EDITOR_TRUNCATED_MESSAGE;
}

function editorMatchOffsets(content: string, search: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (true) {
		const match = content.indexOf(search, offset);
		if (match < 0) return offsets;
		offsets.push(match);
		offset = match + search.length;
	}
}

function editorLineNumbersAt(content: string, offsets: readonly number[]): number[] {
	let line = 1;
	let cursor = 0;
	return offsets.map((offset) => {
		while (cursor < offset) {
			if (content[cursor] === "\n") line += 1;
			cursor += 1;
		}
		return line;
	});
}

function editorResolvePath(path: string): string {
	if (path.trim().length === 0) throw new Error("path must be a non-empty string");
	if (!isAbsolute(path)) {
		throw new Error(
			`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`,
		);
	}
	return path;
}

function editorStatExisting(path: string, command: "view" | "str_replace" | "insert") {
	let info;
	try {
		info = statSync(path);
	} catch {
		throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
	}
	if (info.isDirectory() && command !== "view") {
		throw new Error(
			`The path ${path} is a directory and only the \`view\` command can be used on directories`,
		);
	}
	return info;
}

function editorRequired(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
	if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
	if (!allowEmpty && value.length === 0) throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
	return value;
}

function editorFormatFileView(
	path: string,
	content: string,
	maxOutputChars: number,
	viewRange?: number[],
): string {
	const allLines = content.split("\n");
	let lines = allLines;
	let initialLine = 1;
	let finalLine: number | undefined;
	let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
	if (viewRange !== undefined) {
		const [requestedInitialLine, requestedFinalLine] = viewRange;
		if (
			viewRange.length !== 2 ||
			requestedInitialLine === undefined ||
			requestedFinalLine === undefined ||
			!viewRange.every(Number.isInteger)
		) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		initialLine = requestedInitialLine;
		finalLine = requestedFinalLine;
		if (initialLine < 1 || initialLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
			);
		}
		if (finalLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
			);
		}
		if (finalLine !== -1 && finalLine < initialLine) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
			);
		}
		lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
		prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
	}
	const numbered = lines
		.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
		.join("\n");
	return editorTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars);
}

function editorListDirectory(path: string, maxOutputChars: number): string {
	function visit(dir: string, depth: number): string[] {
		const rows: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
			const entryPath = join(dir, entry.name);
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
			rows.push(`${type}\t${entryPath}`);
			if (entry.isDirectory() && depth < 2) rows.push(...visit(entryPath, depth + 1));
		}
		return rows;
	}
	const rows = [`d\t${path}`, ...visit(path, 1)];
	rows.sort((left, right) => {
		const leftPath = left.slice(left.indexOf("\t") + 1);
		const rightPath = right.slice(right.indexOf("\t") + 1);
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});
	const listing = editorTruncate(rows.join("\n") + "\n", maxOutputChars);
	return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function editorExecute(args: EditorArgs, maxOutputChars: number): string {
	const path = editorResolvePath(args.path);
	switch (args.command) {
		case "view": {
			const info = editorStatExisting(path, "view");
			if (info.isDirectory()) {
				if (args.view_range !== undefined) {
					throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
				}
				return editorListDirectory(path, maxOutputChars);
			}
			if (!info.isFile()) throw new Error(`cannot view "${path}": not a regular file or directory`);
			return editorFormatFileView(path, readFileSync(path, "utf-8"), maxOutputChars, args.view_range);
		}
		case "create": {
			const fileText = editorRequired(args.file_text, "file_text", "create");
			if (existsSync(path)) {
				throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
			}
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, fileText, "utf-8");
			return `New file created successfully at: ${path}`;
		}
		case "str_replace": {
			const oldValue = editorRequired(args.old_str, "old_str", "str_replace", false);
			const newValue = args.new_str ?? "";
			const info = editorStatExisting(path, "str_replace");
			if (!info.isFile()) throw new Error(`cannot edit "${path}": not a regular file`);
			const before = readFileSync(path, "utf-8");
			const offsets = editorMatchOffsets(before, oldValue);
			const offset = offsets[0];
			if (offset === undefined) {
				throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${path}.`);
			}
			if (offsets.length > 1) {
				const lines = editorLineNumbersAt(before, offsets);
				throw new Error(
					`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
				);
			}
			writeFileSync(path, before.slice(0, offset) + newValue + before.slice(offset + oldValue.length), "utf-8");
			return `The file ${path} has been edited successfully.`;
		}
		case "insert": {
			if (args.insert_line === undefined) {
				throw new Error("Parameter `insert_line` is required for command: insert");
			}
			const value = editorRequired(args.new_str, "new_str", "insert");
			const info = editorStatExisting(path, "insert");
			if (!info.isFile()) throw new Error(`cannot insert into "${path}": not a regular file`);
			const before = readFileSync(path, "utf-8");
			const lines = before.split("\n");
			if (!Number.isInteger(args.insert_line) || args.insert_line < 0 || args.insert_line > lines.length) {
				throw new Error(
					`Invalid \`insert_line\`: ${args.insert_line}. It should be an integer between 0 and ${lines.length}`,
				);
			}
			const after = lines.slice();
			after.splice(args.insert_line, 0, value);
			writeFileSync(path, after.join("\n"), "utf-8");
			return `The file ${path} has been edited successfully.`;
		}
	}
}

/** 注册 str_replace_editor 工具（仅目标模型会话调用；schema 对齐官方 Minimal）。 */
function registerEditorTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "str_replace_editor",
		label: "str_replace_editor",
		description: EDITOR_DESCRIPTION,
		parameters: Type.Object({
			command: Type.String({
				enum: ["view", "create", "str_replace", "insert"],
				description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
			}),
			path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
			file_text: Type.Optional(
				Type.String({ description: "Required parameter of `create` command, with the content of the file to be created." }),
			),
			insert_line: Type.Optional(
				Type.Integer({
					description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
				}),
			),
			new_str: Type.Optional(
				Type.String({
					description:
						"Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
				}),
			),
			old_str: Type.Optional(
				Type.String({
					description:
						"Required parameter of `str_replace` command containing the string in `path` to replace.",
				}),
			),
			view_range: Type.Optional(
				Type.Array(Type.Integer(), {
					description:
						"Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const text = editorExecute(params as EditorArgs, EDITOR_MAX_OUTPUT_CHARS);
			return { content: [{ type: "text", text }], details: {} };
		},
	} as unknown as Parameters<typeof pi.registerTool>[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// 工具过滤（fail-safe）
// ────────────────────────────────────────────────────────────────────────────

type ToolLike = {
	name?: string;
	type?: string;
	function?: { name?: string };
	custom?: { name?: string };
};

/** 兼容三种序列化格式取工具名（对齐 omp-pi-anchored-standard 的 toolName）。 */
export function toolName(t: ToolLike | undefined): string | undefined {
	if (!t || typeof t !== "object") return undefined;
	if (t.type === "function" && t.function && typeof t.function.name === "string" && t.function.name.length > 0) {
		return t.function.name;
	}
	if (t.type === "custom" && t.custom && typeof t.custom.name === "string" && t.custom.name.length > 0) {
		return t.custom.name;
	}
	if (typeof t.name === "string" && t.name.length > 0) return t.name;
	return undefined;
}

/** 校验引导工具是否都在目录里；缺失则返回 missing（调用方应跳过过滤并告警）。 */
export function resolveBootstrap(
	fullTools: string[],
	bootstrapTools: string[],
): { tools: string[]; missing: string[] } {
	const available = new Set(fullTools);
	const missing = bootstrapTools.filter((n) => !available.has(n));
	if (missing.length > 0) return { tools: [], missing };
	return { tools: [...new Set(bootstrapTools)], missing: [] };
}

export function filterTools(
	payloadTools: ToolLike[] | undefined,
	bootstrap: string[],
): { changed: boolean; tools: ToolLike[]; missing: string[] } {
	if (!Array.isArray(payloadTools) || payloadTools.length === 0) {
		return { changed: false, tools: payloadTools ?? [], missing: [] };
	}
	const names = payloadTools.map((t) => toolName(t)).filter((n): n is string => typeof n === "string");
	const { tools, missing } = resolveBootstrap(names, bootstrap);
	if (missing.length > 0) return { changed: false, tools: payloadTools, missing };
	const keep = new Set(tools);
	const filtered = payloadTools.filter((t) => {
		const n = toolName(t);
		return n !== undefined && keep.has(n);
	});
	return { changed: filtered.length !== payloadTools.length, tools: filtered, missing: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// 输出预算封顶
// ────────────────────────────────────────────────────────────────────────────

export function capMaxTokens(
	payload: Record<string, unknown>,
	cap: number | undefined,
	promoted: boolean,
): { changed: boolean; payload: Record<string, unknown> } {
	if (cap === undefined) return { changed: false, payload };
	const field = MAX_TOKENS_FIELDS.find((f) => typeof payload[f] === "number");
	if (!field) return { changed: false, payload };
	if (promoted) {
		if (payload[field] === cap) {
			const { [field]: _injected, ...rest } = payload;
			return { changed: true, payload: rest };
		}
		return { changed: false, payload };
	}
	if (payload[field] === cap) return { changed: false, payload };
	return { changed: true, payload: { ...payload, [field]: cap } };
}

// ────────────────────────────────────────────────────────────────────────────
// 日志
// ────────────────────────────────────────────────────────────────────────────

function appendLine(path: string, line: string): void {
	try {
		appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`, "utf8");
	} catch {
		/* 日志失败不影响功能 */
	}
}

/** 无条件活动日志（每个请求调用一次，行数可控）。 */
function activity(line: string): void {
	appendLine(ACTIVITY_LOG_PATH, line);
}

// ────────────────────────────────────────────────────────────────────────────
// 扩展主体
// ────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!envBool("PI_ANCHORED", true)) return;

	// 无条件启动标记
	appendLine(MARKER_PATH, `loaded models=${DEFAULT_MODELS.join(",")} v3`);

	/** 本进程内实际锚定过的 sessionId → 是否仍处引导态。 */
	const anchoredSessions = new Map<string, boolean>();
	const notified = new Set<string>();
	/** 本进程内已晋升的 sessionId（sticky：压缩抹掉历史后仍保持，避免意外重锚定）。 */
	const promotedSessions = new Set<string>();
	/** 服务端 4xx 过的 sessionId（安全网：晋升，避免重试死循环）。 */
	const failedSessions = new Set<string>();
	/** 引导期捕获的原始系统提示词（用于晋升后上下文注回）。 */
	const originalPrompts = new Map<string, string>();
	/** 已注回过上下文的 sessionId。 */
	const contextInjected = new Set<string>();
	let lastUiCtx: { ui?: { setStatus?: (key: string, text?: string) => void } } | undefined;

	function promoteSession(sid: string): void {
		anchoredSessions.set(sid, false); // 仍记着锚定过，但已晋升
		lastUiCtx?.ui?.setStatus?.("anchored", undefined);
	}

	/** 从 payload.tools 里移除指定工具（用于非目标模型隐藏 str_replace_editor 等自定义工具）。 */
	const stripToolFromPayload = (payload: Record<string, unknown>, name: string): void => {
		const tools = payload.tools;
		if (!Array.isArray(tools)) return;
		const before = tools.length;
		payload.tools = (tools as ToolLike[]).filter((t) => toolName(t) !== name);
		if ((payload.tools as ToolLike[]).length !== before) {
			activity(`stripped tool=${name} from non-target payload`);
		}
	};

	// 目标模型会话才注册 str_replace_editor（非目标模型看不到/用不到这个自定义工具）
	pi.on("session_start", (_event, ctx) => {
		try {
			const cfg = resolveConfig(loadRawConfig(ctx.cwd, ctx.isProjectTrusted()));
			const model = ctx.model;
			if (!cfg.enabled || !model || !modelMatches(model.id, model.provider, cfg.models)) return;
			// 防重复注册（session_start 可能对同一会话触发多次）
			const exists = pi
				.getAllTools?.()
				?.some((t) => t.name === "str_replace_editor");
			if (exists) return;
			registerEditorTool(pi);
		} catch {
			/* 忽略：工具注册失败不应中断会话 */
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const cfg = resolveConfig(loadRawConfig(ctx.cwd, ctx.isProjectTrusted()));
			const debug = cfg.debug;
			const dbg = (line: string) => {
				if (debug) appendLine(DEBUG_LOG_PATH, line);
			};

			const payload = event.payload as Record<string, unknown> | null;
			if (!payload || typeof payload !== "object") return;

			const modelId = String(payload.model ?? ctx.model?.id ?? "");
			const provider = String(ctx.model?.provider ?? "");
			if (!modelMatches(modelId, provider, cfg.models)) {
				// 非目标模型：隐藏自定义引导工具（应对会话中途切到非目标模型的情况）
				stripToolFromPayload(payload, "str_replace_editor");
				activity(`req model=${provider}/${modelId} → not-targeted (models=${cfg.models.join(",")})`);
				return;
			}

			// 子代理豁免：无 UI 上下文的会话（ctx.hasUI === false）跳过预热，始终全目录 + 自己的系统提示词
			if (cfg.exemptSubagents && ctx.hasUI === false) {
				const subSid = ctx.sessionManager?.getSessionId?.() ?? "";
				activity(`req model=${provider}/${modelId} session=${subSid} → subagent-exempt (full catalog)`);
				return;
			}

			const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [];
			const sid = ctx.sessionManager?.getSessionId?.() ?? "";
			const historyPromoted = isPromoted(messages, cfg.promoteOn);
			// sticky：首次从历史判定为晋升后记住，压缩（历史被 summary 替换）后不再回退到 bootstrap。
			// promoteOn === "never"（minimal 预设）时不记录，保持永不晋升。
			if (historyPromoted && cfg.promoteOn !== "never") {
				if (!promotedSessions.has(sid)) {
					promotedSessions.add(sid);
					activity(`session=${sid} → promotion sticky (survives compaction)`);
				}
			}
			const promoted =
				(cfg.promoteOn !== "never" && promotedSessions.has(sid)) ||
				failedSessions.has(sid) ||
				historyPromoted;

			// 无条件：每个请求第一行记录模型 + 实际工具名 + 消息数（fail-safe/异常也看得见）
			const payloadTools = Array.isArray(payload.tools) ? (payload.tools as ToolLike[]) : [];
			const toolNames = payloadTools.map((t) => toolName(t) ?? "").filter(Boolean);
			activity(
				`req model=${provider}/${modelId} session=${sid} tools=[${toolNames.join(",")}] ` +
					`msgs=${messages.length} promoteOn=${cfg.promoteOn} → ${promoted ? "promoted" : "bootstrap-candidate"}`,
			);

			// 引导期捕获原始系统提示词：晋升后（保留 persona 时）以 user message 注回，模型不丢 pi 上下文
			if (
				!promoted &&
				!cfg.restorePrompt &&
				cfg.contextReinject &&
				cfg.bootstrapPrompt === "minimal" &&
				!originalPrompts.has(sid)
			) {
				const sysMsg = findSystemMessage(messages);
				if (sysMsg && typeof sysMsg.msg.content === "string") {
					originalPrompts.set(sid, sysMsg.msg.content);
				}
			}

			// 晋升通知（一次性）
			if (cfg.notify && sid && anchoredSessions.get(sid) && promoted && !notified.has(sid)) {
				notified.add(sid);
				ctx.ui?.notify?.(`[anchored-tools] ${provider}/${modelId}: session promoted — full tool catalog restored.`, "info");
			}

			if (promoted) {
				lastUiCtx = ctx;
				promoteSession(sid);
				// 工具已恢复全目录；是否保留引导提示词由 restorePrompt 决定（false = 整段会话保持，DSH 验证配置）
				let changed = false;
				let out: Record<string, unknown> = payload;
				if (!cfg.restorePrompt && cfg.bootstrapPrompt !== "none") {
					const p = applyPromptMode(out, cfg.bootstrapPrompt, cfg.bootstrapTools);
					if (p.changed) {
						out = p.payload;
						changed = true;
					}
				}
				// 剥离注入的输出预算上限，恢复宿主默认
				const capped = capMaxTokens(out, cfg.bootstrapMaxTokens, true);
				if (capped.changed) {
					out = capped.payload;
					changed = true;
				}
				activity(
					`req model=${provider}/${modelId} session=${sid} → promoted (full catalog${changed ? ", prompt kept" : ""})`,
				);
				return changed ? out : undefined;
			}

			// ── 引导阶段 ──
			let next: Record<string, unknown> = { ...payload };

			// 1) 系统提示词
			const prompt = applyPromptMode(next, cfg.bootstrapPrompt, cfg.bootstrapTools);
			if (prompt.changed) next = prompt.payload;

			// 2) 工具目录（fail-safe：缺失则跳过整个引导并告警）
			const tools = payload.tools as ToolLike[] | undefined;
			if (Array.isArray(tools) && tools.length > 0) {
				const names = tools.map((t) => toolName(t)).filter((n): n is string => typeof n === "string");
				const { missing } = resolveBootstrap(names, cfg.bootstrapTools);
				if (missing.length > 0) {
					const warn = `[anchored-tools] bootstrap tools missing from catalog: ${missing.join(", ")}; skipping filter`;
					activity(`fail-safe: ${warn}`);
					console.warn(warn);
					return prompt.changed ? next : undefined;
				}
				const filtered = filterTools(tools, cfg.bootstrapTools);
				if (filtered.changed) {
					next = { ...next, tools: filtered.tools };
				}
			}

			// 3) 输出预算封顶（可选）
			const capped = capMaxTokens(next, cfg.bootstrapMaxTokens, false);
			if (capped.changed) next = capped.payload;

			anchoredSessions.set(sid, true);
			lastUiCtx = ctx;
			ctx.ui?.setStatus?.("anchored", `[⛓ bootstrap: ${cfg.bootstrapTools.join("+")}]`);
			activity(
				`req model=${provider}/${modelId} session=${sid} → BOOTSTRAP promptMode=${cfg.bootstrapPrompt} ` +
					`tools=${((next.tools as ToolLike[]) ?? []).map((t) => toolName(t) ?? "").filter(Boolean).join(",") || "(none)"} msgs=${messages.length}`,
			);
			dbg(
				`req model=${provider}/${modelId} session=${sid} promptMode=${cfg.bootstrapPrompt} ` +
					`tools=${((next.tools as ToolLike[]) ?? []).map((t) => toolName(t) ?? "").filter(Boolean).join(",") || "(none)"} msgs=${messages.length}`,
			);
			return next;
		} catch (err) {
			const msg = (err as Error).message;
			activity(`req ERROR: ${msg}`);
			console.warn(`[anchored-tools] before_provider_request error: ${msg}`);
			return; // 隔离：任何异常都不拦截请求
		}
	});

	// 晋升后上下文注回：保留 persona（restorePrompt:false + contextReinject + minimal）时，
	// 把引导期捕获的 pi 原始提示词以持久 user message 注入（一次性；resume 已注入则跳过）。
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const cfg = resolveConfig(loadRawConfig(ctx.cwd, ctx.isProjectTrusted()));
			if (!cfg.enabled) return;
			const sid = ctx.sessionManager?.getSessionId?.() ?? "";
			if (!sid || contextInjected.has(sid)) return;
			if (cfg.exemptSubagents && ctx.hasUI === false) return;
			const model = ctx.model;
			if (!model || !modelMatches(model.id, model.provider, cfg.models)) return;
			const entries = ctx.sessionManager?.buildContextEntries?.() ?? [];
			if (cfg.promoteOn === "never" || !isPromotedEntries(entries, cfg.promoteOn)) return;
			if (cfg.restorePrompt || !cfg.contextReinject || cfg.bootstrapPrompt !== "minimal") return;
			// resume 场景：历史里已有注回消息则跳过（避免重复）
			const already = (entries ?? []).some(
				(e) =>
					(e as { type?: string; customType?: string })?.type === "custom" &&
					(e as { customType?: string })?.customType === "anchored-context",
			);
			if (already) {
				contextInjected.add(sid);
				return;
			}
			const original = originalPrompts.get(sid);
			if (!original) return;
			contextInjected.add(sid);
			activity(`context-reinject session=${sid} (${original.length} chars)`);
			return {
				message: { customType: "anchored-context", content: original, display: false },
			};
		} catch {
			return; // 隔离：注入失败不影响会话
		}
	});

	// 安全网：服务端 4xx → 晋升本会话，避免重试死循环
	pi.on("after_provider_response", (event, ctx) => {
		try {
			if (event.status >= 400 && event.status < 500) {
				const sid = ctx.sessionManager?.getSessionId?.() ?? "";
				failedSessions.add(sid);
				promoteSession(sid);
			}
		} catch {
			/* 忽略 */
		}
	});

	pi.on("session_shutdown", () => {
		anchoredSessions.clear();
		notified.clear();
		originalPrompts.clear();
		contextInjected.clear();
		failedSessions.clear();
		promotedSessions.clear();
	});

	// 诊断 + 交互式设置命令：无参数弹菜单；也可显式传参（preset <名> / on / off / promote）；Tab 补全
	pi.registerCommand("anchored-tools", {
	description: "anchored-standard: interactive settings (preset / advanced / status)",
	getArgumentCompletions: (prefix: string) => {
		const p = (prefix ?? "").trimStart();
		// Completions stay English (no ctx available); the menu is the localized surface.
		const PRESET_HINTS: Record<string, string> = {
			anchor: "recommended — persona stays + pi context reinjected",
			"anchor-restore": "restore the original pi prompt after promotion",
			minimal: "never promotes, two tools for the whole session",
			native: "no anchoring (baseline)",
		};
		const sub = p.replace(/^preset\s+/i, "");
		return (Object.keys(PRESET_HINTS) as PresetName[])
			.filter((v) => v.startsWith(sub))
			.map((v) => ({
				value: `preset ${v}`,
				label: v,
				description: PRESET_HINTS[v],
			}));
	},
	handler: async (args, ctx) => {
		try {
			const model = ctx.model;

			const showStatus = () => {
				const cur = freshCfg();
				const t = makeT(cur.locale);
				const matched = model ? modelMatches(model.id, model.provider, cur.models) : false;
				const entries = ctx.sessionManager?.buildContextEntries?.() ?? [];
				const promoted = isPromotedEntries(entries, cur.promoteOn);
				const phase = !cur.enabled
					? t("phaseDisabled")
					: !matched
						? t("phaseNotTargeted")
						: promoted
							? t("phasePromoted")
							: t("phaseBootstrap", cur.bootstrapTools.join(", "));
				const lines = [
					t("statusPreset", cur.preset),
					t("statusEnabled", cur.enabled),
					t("statusPromoteOn", cur.promoteOn),
					t("statusPrompt", cur.bootstrapPrompt, cur.restorePrompt, cur.contextReinject),
					t("statusTools", cur.bootstrapTools.join(", ")),
					t("statusMaxTokens", cur.bootstrapMaxTokens ?? t("offDefault")),
					t("statusExempt", cur.exemptSubagents),
					t("statusModels", cur.models.join(", ") || t("none")),
					t("statusModel", model ? `${model.provider}/${model.id}` : t("nA")),
					t("statusMatched", matched ? t("yes") : t("no")),
					t("statusPhase", phase),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			};

			const writeConfig = (patch: Record<string, unknown>): boolean => {
				const t = makeT(freshCfg().locale);
				try {
					const path = join(getAgentDir(), "settings.json");
					const parsed = readSettingsJson(path);
					if (!parsed) {
						ctx.ui.notify(t("writeFailed", path), "error");
						return false;
					}
					parsed.anchoredTools = {
						...(parsed.anchoredTools as Record<string, unknown> | undefined),
						...patch,
					};
					writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
					return true;
				} catch (err) {
					ctx.ui.notify(t("writeError", (err as Error).message), "error");
					return false;
				}
			};
			const writePreset = (presetName: string) => writeConfig({ preset: presetName });
			// 每次操作后重读配置（菜单内修改会立即反映到标题/勾选状态/语言）
			const freshCfg = () => resolveConfig(loadRawConfig(ctx.cwd, ctx.isProjectTrusted()));

			// 显式参数模式：只支持 preset <名>（Tab 补全直接给出 4 个预设）
			const argsText = (args ?? "").trim();
			if (argsText) {
				const t = makeT(freshCfg().locale);
				const m = argsText.match(/^preset\s+(.+)$/i);
				const arg = m ? m[1].trim() : argsText.trim();
				if (isPresetName(arg)) {
					if (writePreset(arg)) ctx.ui.notify(t("presetPersisted", arg), "info");
					return;
				}
				ctx.ui.notify(t("usage"), "warning");
				return;
			}

			// ── 层级菜单（返回上级 / Esc 都回到上级；仅顶层 Esc 退出整个菜单）──
			const PRESET_NAMES = ["anchor", "anchor-restore", "minimal", "native"] as PresetName[];

			/** 目标模型勾选菜单 */
			const showModelsMenu = async (): Promise<boolean> => {
				while (true) {
					const cur = freshCfg();
					const t = makeT(cur.locale);
					const currentModels = cur.models;
					const options = [
						t("modelToggle", "deepseek-v4-pro", currentModels.includes("deepseek-v4-pro")),
						t("modelToggle", "deepseek-v4-flash", currentModels.includes("deepseek-v4-flash")),
						t("done"),
					];
					const choice = await ctx.ui.select(t("modelsTitle", currentModels.join(", ") || t("none")), options);
					if (!choice || choice === t("done")) return true; // Esc / Done → back to advanced
					const model = choice.includes("deepseek-v4-pro") ? "deepseek-v4-pro" : "deepseek-v4-flash";
					const next = new Set(currentModels);
					if (next.has(model)) next.delete(model);
					else next.add(model);
					if (next.size === 0) {
						ctx.ui.notify(t("atLeastOneModel"), "warning");
						continue;
					}
					if (writeConfig({ models: [...next] })) {
						ctx.ui.notify(t("modelsPersisted", [...next].join(", ")), "info");
					}
				}
			};

			/** 语言切换子菜单 */
			const showLanguageMenu = async (): Promise<boolean> => {
				while (true) {
					const cur = freshCfg();
					const t = makeT(cur.locale);
					const choice = await ctx.ui.select(
						t("languageTitle", cur.locale === "zh" ? t("languageZh") : t("languageEn")),
						[t("languageEn"), t("languageZh"), t("back")],
					);
					if (!choice || choice === t("back")) return true;
					const locale: Locale = choice === "English" ? "en" : "zh";
					if (writeConfig({ locale })) {
						ctx.ui.notify(t("languagePersisted", locale), "info");
					}
					// 循环：切换后立刻用新语言重绘
				}
			};

			/** 高级设置子菜单 */
			const showAdvancedMenu = async (): Promise<boolean> => {
				while (true) {
					const cur = freshCfg();
					const t = makeT(cur.locale);
					const sub = await ctx.ui.select(t("advancedTitle", cur.preset), [
						t("targetModels", cur.models.join(", ")),
						t("subagentExemption", cur.exemptSubagents ? t("enabled") : t("disabled")),
						t("language", cur.locale === "zh" ? t("languageZh") : t("languageEn")),
						t("back"),
					]);
					if (!sub || sub === t("back")) return true; // Esc / Back → top level
					if (sub.startsWith("🎛") || sub.includes(t("targetModels", "").slice(3))) {
						const keep = await showModelsMenu();
						if (!keep) return false;
						continue;
					}
					if (sub.startsWith("🤖") || sub.includes(t("subagentExemption", "").slice(3))) {
						const c = freshCfg();
						const t2 = makeT(c.locale);
						const choice = await ctx.ui.select(t2("exemptionTitle", c.exemptSubagents ? t2("enabled") : t2("disabled")), [
							t2("exemptionEnabled"),
							t2("exemptionDisabled"),
							t2("back"),
						]);
						if (!choice || choice === t2("back")) continue;
						const value = choice.startsWith("✅");
						if (writeConfig({ exemptSubagents: value })) {
							ctx.ui.notify(t2("exemptionPersisted", value), "info");
						}
						continue;
					}
					if (sub.startsWith("🌐") || sub.includes(t("language", "").slice(3))) {
						await showLanguageMenu();
						continue;
					}
				}
			};

			/** 预设子菜单 */
			const showPresetMenu = async (): Promise<boolean> => {
				const cur = freshCfg();
				const t = makeT(cur.locale);
				const labels: Record<PresetName, string> = {
					anchor: t("presetAnchor"),
					"anchor-restore": t("presetAnchorRestore"),
					minimal: t("presetMinimal"),
					native: t("presetNative"),
				};
				const sub = await ctx.ui.select(t("presetTitle", cur.preset), [
					...PRESET_NAMES.map((key) => `${labels[key]}${key === cur.preset ? t("currentSuffix") : ""}`),
					t("back"),
				]);
				if (!sub || sub === t("back")) return true; // Esc / Back → top level
				// 用 “key —” 精确前缀匹配，避免 “anchor” 误吞 “anchor-restore”
				const key = PRESET_NAMES.find((k) => sub.startsWith(`${k} —`));
				if (key && writePreset(key)) {
					ctx.ui.notify(t("presetPersisted", key), "info");
				}
				return true;
			};

			// 顶层循环：Esc 才退出整个菜单
			while (true) {
				const cur = freshCfg();
				const t = makeT(cur.locale);
				const matched = model ? modelMatches(model.id, model.provider, cur.models) : false;
				const entries2 = ctx.sessionManager?.buildContextEntries?.() ?? [];
				const promotedNow = isPromotedEntries(entries2, cur.promoteOn);
				const phaseNow = !cur.enabled
					? t("phaseDisabled")
					: !matched
						? t("phaseNotTargeted")
						: promotedNow
							? t("phasePromoted")
							: t("phaseBootstrap", cur.bootstrapTools.join(", "));
				const topChoice = await ctx.ui.select(t("topTitle", cur.preset, phaseNow), [
					t("switchPreset"),
					t("advanced"),
					t("status"),
				]);
				if (!topChoice) return; // 顶层 Esc → 整个退出
				if (topChoice.startsWith("🎯")) {
					const keep = await showPresetMenu();
					if (!keep) return;
				} else if (topChoice.startsWith("⚙️")) {
					const keep = await showAdvancedMenu();
					if (!keep) return;
				} else {
					showStatus();
				}
			}
		} catch (err) {
			// freshCfg is scoped inside try; fall back to English for error reporting
			const t = makeT("en");
			ctx.ui.notify(t("error", (err as Error).message), "error");
		}
	},
});
}
