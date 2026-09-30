/**
 * /anchored-tools 交互式菜单 + i18n。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale, PresetName } from "./config.js";
import { isExactPattern, isPresetName, loadRawConfig, modelMatches, parseRegexPattern, readSettingsJson, resolveConfig } from "./config.js";
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
		modelsTitle: (on: number, total: number) => `Target models (${on}/${total} anchored)`,
		rulesHeader: "── Matching rules ──",
		modelsHeader: "── Models ──",
		ruleEntry: (pattern: string, n: number) => `☑ 📜 ${pattern} (${n} matched)`,
		addRule: "➕ Add rule (glob or /regex/flags)",
		addRuleTitle: "New matching rule",
		addRulePlaceholder: "/deepseek.*flash/i  |  *deepseek-v4*  |  provider/model-id",
		ruleDuplicate: (rule: string) => `[anchored-tools] rule already exists: ${rule}`,
		ruleInvalid: (rule: string) => `[anchored-tools] invalid regex syntax: ${rule}`,
		modelToggle: (name: string, ruleCovered: boolean, on: boolean) =>
			`${on ? "☑" : "☐"}${ruleCovered ? " 📜" : ""} ${name}`,
		ruleDisabledEntry: (pattern: string) => `⏸ 📜 ${pattern} (disabled)`,
		ruleActionTitle: (pattern: string) => `Rule: ${pattern}`,
		ruleEdit: "✏️ Edit (re-enter value)",
		ruleDisable: "⏸ Disable (kept for re-enabling)",
		ruleEnable: "▶️ Enable",
		ruleDelete: "🗑 Delete permanently",
		editRuleTitle: (pattern: string) => `Edit rule — current: ${pattern}`,
		rulesPersisted: (models: string, disabled: string) =>
			`[anchored-tools] rules → [${models}] / disabled → [${disabled}] (persisted)`,
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
		modelsTitle: (on: number, total: number) => `目标模型（生效 ${on}/${total}）`,
		rulesHeader: "── 匹配规则 ──",
		modelsHeader: "── 模型 ──",
		ruleEntry: (pattern: string, n: number) => `☑ 📜 ${pattern}（命中 ${n}）`,
		addRule: "➕ 添加规则（glob 或 /正则/flags）",
		addRuleTitle: "新增匹配规则",
		addRulePlaceholder: "/deepseek.*flash/i  |  *deepseek-v4*  |  provider/model-id",
		ruleDuplicate: (rule: string) => `[anchored-tools] 规则已存在：${rule}`,
		ruleInvalid: (rule: string) => `[anchored-tools] 非法正则语法：${rule}`,
		modelToggle: (name: string, ruleCovered: boolean, on: boolean) =>
			`${on ? "☑" : "☐"}${ruleCovered ? " 📜" : ""} ${name}`,
		ruleDisabledEntry: (pattern: string) => `⏸ 📜 ${pattern}（已停用）`,
		ruleActionTitle: (pattern: string) => `规则：${pattern}`,
		ruleEdit: "✏️ 编辑（重新输入）",
		ruleDisable: "⏸ 停用（保留，可再启用）",
		ruleEnable: "▶️ 启用",
		ruleDelete: "🗑 彻底删除",
		editRuleTitle: (pattern: string) => `编辑规则 — 当前：${pattern}`,
		rulesPersisted: (models: string, disabled: string) =>
			`[anchored-tools] 规则 → [${models}] / 停用 → [${disabled}]（已持久化）`,
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

				/**
				 * 目标模型菜单 —— 两个正交指示器：
				 *  - 模型区：☐/☑ = 手动状态（点击一律加/删 provider 限定精确条目）；框后 📜 = 被非精确规则覆盖
				 *    （实际生效 = 框 ∨ 📜，标题"生效 N/M"按实际生效计数）
				 *  - 规则区：☑ 📜 模式（命中 N）= 生效；⏸ 📜 模式 = 已停用（disabledModels 暂存，不参与匹配）
				 *    点击规则 → 子菜单：编辑 / 停用或启用 / 删除
				 *  - ➕ 添加规则 → input 弹窗；若已在停用区则自动启用
				 */
				const showModelsMenu = async (): Promise<boolean> => {
					while (true) {
						const cur = freshCfg();
						const t = makeT(cur.locale);
						const patterns = cur.models;
						const disabled = cur.disabledModels;
						// 规则写入统一走这里（同时维护 models / disabledModels）
						const writeRules = (m: string[], d: string[]) => {
							if (writeConfig({ models: m, disabledModels: d })) {
								ctx.ui.notify(t("rulesPersisted", m.join(", ") || t("none"), d.join(", ") || t("none")), "info");
							}
						};
						// 形如 /…/flags 却编译失败 → 非法正则（避免静默存成永远匹配不上的 glob）
						const badRule = (rule: string): boolean =>
							/^\/.+\/[a-z]*$/s.test(rule) && !parseRegexPattern(rule);

						// 发现模型：DeepSeek 系 ∪ 被任一现有规则命中（含自定义正则，如 /qwen.*/）。
						// getAvailable() 仅返回已配置鉴权的模型；不可用时退化为 getAll()。
						const discovered: { id: string; provider: string }[] = [];
						const seen = new Set<string>();
						try {
							const registry = ctx.modelRegistry;
							const available = registry?.getAvailable?.() ?? [];
							const all = available.length > 0 ? available : (registry?.getAll?.() ?? []);
							for (const m of all) {
								const id = String((m as { id?: string }).id ?? "");
								const prov = String((m as { provider?: string }).provider ?? "");
								const qualified = `${prov}/${id}`;
								if (!id || seen.has(qualified)) continue;
								if (!/deepseek/i.test(qualified) && !modelMatches(id, prov, patterns)) continue;
								seen.add(qualified);
								discovered.push({ id, provider: prov });
							}
						} catch {
							/* 注册表不可用则只显示规则区 */
						}
						discovered.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

						// 模型区：☐/☑ = 手动状态（有无精确条目）；📜 = 被非精确规则覆盖。
						const modelEntries = discovered.map((m) => {
							const qualified = `${m.provider}/${m.id}`;
							const exactHit = patterns.find(
								(p) => isExactPattern(p) && modelMatches(m.id, m.provider, [p]),
							);
							const ruleCovered = patterns.some(
								(p) => !isExactPattern(p) && modelMatches(m.id, m.provider, [p]),
							);
							return {
								...m,
								qualified,
								explicit: exactHit !== undefined,
								effective: exactHit !== undefined || ruleCovered,
								label: t("modelToggle", qualified, ruleCovered, exactHit !== undefined),
							};
						});
						// 规则区：未被"精确条目吸附"的生效模式 + 全部停用模式
						const isAdsorbed = (p: string) =>
							isExactPattern(p) && modelEntries.some((e) => modelMatches(e.id, e.provider, [p]));
						const ruleEntries = [
							...patterns
								.filter((p) => !isAdsorbed(p))
								.map((p) => ({
									pattern: p,
									active: true,
									label: t(
										"ruleEntry",
										p,
										discovered.filter((m) => modelMatches(m.id, m.provider, [p])).length,
									),
								})),
							...disabled.map((p) => ({ pattern: p, active: false, label: t("ruleDisabledEntry", p) })),
						];

						// 单条规则的管理子菜单：编辑 / 停用或启用 / 删除
						const ruleAction = async (r: { pattern: string; active: boolean }): Promise<void> => {
							while (true) {
								const sub = await ctx.ui.select(t("ruleActionTitle", r.pattern), [
									t("ruleEdit"),
									r.active ? t("ruleDisable") : t("ruleEnable"),
									t("ruleDelete"),
									t("back"),
								]);
								if (!sub || sub === t("back")) return;
								if (sub === t("ruleEdit")) {
									const raw = await ctx.ui.input(t("editRuleTitle", r.pattern), r.pattern);
									const rule = (raw ?? "").trim();
									if (!rule || rule === r.pattern) continue; // 取消 / 未变更
									if (patterns.includes(rule) || disabled.includes(rule)) {
										ctx.ui.notify(t("ruleDuplicate", rule), "warning");
										continue;
									}
									if (badRule(rule)) {
										ctx.ui.notify(t("ruleInvalid", rule), "warning");
										continue;
									}
									if (r.active) writeRules(patterns.map((p) => (p === r.pattern ? rule : p)), disabled);
									else writeRules(patterns, disabled.map((p) => (p === r.pattern ? rule : p)));
									return;
								}
								if (sub === t("ruleDisable")) {
									if (patterns.length <= 1) {
										ctx.ui.notify(t("atLeastOneModel"), "warning");
										return;
									}
									writeRules(patterns.filter((p) => p !== r.pattern), [...disabled, r.pattern]);
									return;
								}
								if (sub === t("ruleEnable")) {
									writeRules(
										patterns.includes(r.pattern) ? patterns : [...patterns, r.pattern],
										disabled.filter((p) => p !== r.pattern),
									);
									return;
								}
								// 彻底删除：生效区最后一条 → 守卫
								if (r.active && patterns.length <= 1) {
									ctx.ui.notify(t("atLeastOneModel"), "warning");
									return;
								}
								if (r.active) writeRules(patterns.filter((p) => p !== r.pattern), disabled);
								else writeRules(patterns, disabled.filter((p) => p !== r.pattern));
								return;
							}
						};

						const options: string[] = [];
						const actions = new Map<string, () => void | Promise<void>>();
						options.push(t("rulesHeader"));
						for (const r of ruleEntries) {
							options.push(r.label);
							actions.set(r.label, () => ruleAction(r));
						}
						options.push(t("addRule"));
						actions.set(t("addRule"), async () => {
							const raw = await ctx.ui.input(t("addRuleTitle"), t("addRulePlaceholder"));
							const rule = (raw ?? "").trim();
							if (!rule) return; // Esc / 空输入 → 取消
							if (patterns.includes(rule)) {
								ctx.ui.notify(t("ruleDuplicate", rule), "warning");
								return;
							}
							if (badRule(rule)) {
								ctx.ui.notify(t("ruleInvalid", rule), "warning");
								return;
							}
							// 停用区已有 → 直接启用，而非报"已存在"
							if (disabled.includes(rule)) {
								writeRules([...patterns, rule], disabled.filter((p) => p !== rule));
								return;
							}
							writeRules([...patterns, rule], disabled);
						});
						if (modelEntries.length > 0) options.push(t("modelsHeader"));
						for (const e of modelEntries) {
							options.push(e.label);
							actions.set(e.label, () => {
								if (e.explicit) {
									// 手动关闭：移除指向该模型的精确条目（📜 覆盖与否由图标自解释）
									const next = patterns.filter(
										(p) => !(isExactPattern(p) && modelMatches(e.id, e.provider, [p])),
									);
									if (next.length === 0) {
										ctx.ui.notify(t("atLeastOneModel"), "warning");
										return;
									}
									if (writeConfig({ models: next })) {
										ctx.ui.notify(t("modelsPersisted", next.join(", ")), "info");
									}
									return;
								}
								// 手动开启：写入 provider 限定精确条目
								const next = [...patterns, e.qualified];
								if (writeConfig({ models: next })) {
									ctx.ui.notify(t("modelsPersisted", next.join(", ")), "info");
								}
							});
						}
						options.push(t("done"));

						const on = modelEntries.filter((e) => e.effective).length;
						const choice = await ctx.ui.select(t("modelsTitle", on, discovered.length), options);
						if (!choice || choice === t("done")) return true; // Esc / Done → back to advanced
						await actions.get(choice)?.(); // 区块标题行不在 actions 里 → 点击仅重绘
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
