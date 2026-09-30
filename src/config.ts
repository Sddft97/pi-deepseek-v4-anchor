/**
 * 配置：常量、预设、settings.json 读取/合并、模型匹配。
 * 格式无关 —— 不涉及任何 provider payload 的具体结构。
 */
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** DSH minimal preset 的完整 persona（逐字节一致，不得改写）。 */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

export const DEFAULT_MODELS = ["/deepseek.*(flash|pro)/i"];
export const DEFAULT_BOOTSTRAP_TOOLS = ["bash", "str_replace_editor"];

// ────────────────────────────────────────────────────────────────────────────
// 类型与预设
// ────────────────────────────────────────────────────────────────────────────

export type PromoteOn = "tool-call" | "assistant-message" | "either" | "never";
export type BootstrapPrompt = "minimal" | "trim" | "none";
export type PresetName = "native" | "anchor" | "anchor-restore" | "minimal";
export type Locale = "en" | "zh";

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
	/** 菜单“停用”的规则暂存区：不参与匹配，仅供一键恢复。 */
	disabledModels: string[];
	/** UI language: "en" | "zh". */
	locale: Locale;
	notify: boolean;
	debug: boolean;
}

interface RawAnchoredTools {
	enabled?: unknown;
	preset?: unknown;
	models?: unknown;
	disabledModels?: unknown;
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function envBool(name: string, def: boolean): boolean {
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

export function readSettingsJson(path: string): Record<string, unknown> | undefined {
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
	const globalRaw = readSettingsJson(join(getAgentDir(), "settings.json"))?.anchoredTools as
		| RawAnchoredTools
		| undefined;
	let merged = globalRaw;
	if (projectTrusted) {
		const projectRaw = readSettingsJson(join(cwd, CONFIG_DIR_NAME, "settings.json"))
			?.anchoredTools as RawAnchoredTools | undefined;
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
		disabledModels:
			Array.isArray(r.disabledModels) && r.disabledModels.every((m) => typeof m === "string")
				? [...new Set(r.disabledModels as string[])]
				: [],
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

/**
 * 正则模式：形如 `/pattern/flags` 的字符串按 JS 正则处理，其余按 glob。
 * 这样未来模型命名结构变化时，只需在 settings.json 里改模式即可，无需改代码：
 *   "models": ["/deepseek.*flash/i", "*deepseek-v4*"]
 * 非法正则返回 undefined（回退为 glob 匹配）。
 */
export function parseRegexPattern(pattern: string): { source: string; flags: string } | undefined {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
	if (!m) return undefined;
	try {
		new RegExp(m[1], m[2]); // 提前编译，非法正则视为非正则模式
	} catch {
		return undefined;
	}
	return { source: m[1], flags: m[2] };
}

/** 单个模式匹配：正则或 glob。 */
export function matchPattern(pattern: string, value: string): boolean {
	const rx = parseRegexPattern(pattern);
	if (rx) return new RegExp(rx.source, rx.flags).test(value);
	return matchGlob(pattern, value);
}

/** 精确条目：非正则且不含通配符 —— 只会命中字面等同的 id（UI 用来区分“显式指定”与“规则命中”）。 */
export function isExactPattern(pattern: string): boolean {
	return !parseRegexPattern(pattern) && !/[*?]/.test(pattern);
}

/** 第一条命中该模型的模式；无命中返回 undefined（UI 标注来源用）。 */
export function matchingPattern(modelId: string, provider: string, patterns: string[]): string | undefined {
	const qualified = `${provider}/${modelId}`;
	return patterns.find((p) => {
		// 正则模式同时测试裸 id 与 provider/id，方便写 /deepseek.*flash/i
		const rx = parseRegexPattern(p);
		if (rx) {
			const re = new RegExp(rx.source, rx.flags);
			return re.test(modelId) || re.test(qualified);
		}
		return p.includes("/") ? matchGlob(p, qualified) : matchGlob(p, qualified) || matchGlob(p, modelId);
	});
}

export function modelMatches(modelId: string, provider: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return matchingPattern(modelId, provider, patterns) !== undefined;
}
