/**
 * /anchored-tools 交互式菜单 + i18n。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale, PresetName } from "./config.js";
import { isPresetName, loadRawConfig, modelMatches, readSettingsJson, resolveConfig } from "./config.js";
import { isPromotedEntries } from "./promotion.js";

// ────────────────────────────────────────────────────────────────────────────
// i18n（轻量字典，无外部依赖）
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// 命令
// ────────────────────────────────────────────────────────────────────────────

/** 诊断 + 交互式设置命令：无参数弹菜单；也可显式传参（preset <名>）；Tab 补全。 */
export function registerAnchoredToolsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("anchored-tools", {
		description: "anchored-standard: interactive settings (preset / advanced / status)",
		getArgumentCompletions: (prefix: string) => {
			const p = (prefix ?? "").trimStart();
			// Completions stay English (no ctx available); the menu is the localized surface.
			const PRESET_HINTS: Record<string, string> = {
				anchor: "recommended — persona stays + pi context reinjected",
				"anchor-restore": "restore the original pi prompt after promotion",
				minimal: "never promotes, two tools only",
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
