/**
 * anchored-standard for pi — DeepSeek V4 Pro two-phase tool bootstrap (v4.2)
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
 * v4.2（本地重构）：按 payload 的 API 格式分流到对应 adapter（见 src/format.ts），
 * 状态机本身与格式无关。修复：
 *   - anthropic-messages 的 system 内容块数组此前无法改写 → minimal persona 从不生效
 *   - anthropic 的 tool_use 内容块此前识别不到 → promoteOn:"tool-call" 永不晋升
 *   - 上下文注回此前捕获不到原始提示词
 *   - 日志目录从不创建 → 验证日志静默丢失
 *
 * 功能概览（与上游一致）：
 *   - 预设：native / anchor（默认）/ anchor-restore / minimal
 *   - str_replace_editor：仅目标模型会话注册
 *   - Sticky promotion：晋升后跨压缩保持
 *   - bootstrapMaxTokens：首请求输出封顶（默认 1024，晋升后剥离）
 *   - /anchored-tools 交互菜单（预设 / 高级 / 状态）
 *
 * 配置（settings.json 顶层 "anchoredTools" 键）：见 README。
 * 环境变量：PI_ANCHORED=0 全局禁用；PI_ANCHORED_DEBUG=1 开启调试日志。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, activity, DEBUG_LOG_PATH, MARKER_PATH } from "./src/log.js";
import type { BootstrapPrompt, Config, Locale, PresetName, PromoteOn } from "./src/config.js";
import {
	DEFAULT_BOOTSTRAP_TOOLS,
	DEFAULT_MODELS,
	deepMerge,
	envBool,
	isExactPattern,
	loadRawConfig,
	matchGlob,
	matchPattern,
	matchingPattern,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	parseRegexPattern,
	PRESETS,
	readSettingsJson,
	resolveConfig,
} from "./src/config.js";
import type { PayloadAdapter, PayloadFormat } from "./src/format.js";
import {
	applyPromptMode,
	capMaxTokens,
	detectPayloadFormat,
	filterTools,
	getAdapter,
	resolveBootstrap,
	toolName,
	trimSystemPrompt,
} from "./src/format.js";
import type { ToolLike } from "./src/format.js";
import { isPromoted, isPromotedEntries } from "./src/promotion.js";
import { registerEditorTool } from "./src/editor.js";
import { registerAnchoredToolsCommand } from "./src/menu.js";

// 兼容性再导出（行为与旧 index.ts 同名导出一致）
export {
	DEFAULT_BOOTSTRAP_TOOLS,
	DEFAULT_MODELS,
	MINIMAL_SYSTEM_PROMPT,
	PRESETS,
	deepMerge,
	isExactPattern,
	loadRawConfig,
	matchGlob,
	matchPattern,
	matchingPattern,
	modelMatches,
	parseRegexPattern,
	readSettingsJson,
	resolveConfig,
};
export type { BootstrapPrompt, Config, Locale, PresetName, PromoteOn };
export { detectPayloadFormat, filterTools, getAdapter, resolveBootstrap, toolName, trimSystemPrompt };
export type { PayloadAdapter, PayloadFormat, ToolLike };
export { isPromoted, isPromotedEntries };
export { applyPromptMode, capMaxTokens };

// ────────────────────────────────────────────────────────────────────────────
// 扩展主体
// ────────────────────────────────────────────────────────────────────────────

/** 引导工具名（激活同步与 payload 剥离共用）。 */
const EDITOR_TOOL_NAME = "str_replace_editor";

export default function (pi: ExtensionAPI) {
	if (!envBool("PI_ANCHORED", true)) return;

	// 无条件启动标记
	appendLine(MARKER_PATH, `loaded models=${DEFAULT_MODELS.join(",")} v4.2`);

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

	/** 从 payload.tools 里移除指定工具（兼底：应对 before_agent_start 之后模型才变化的情况）。 */
	const stripToolFromPayload = (payload: Record<string, unknown>, name: string): void => {
		const tools = payload.tools;
		if (!Array.isArray(tools)) return;
		const before = tools.length;
		payload.tools = (tools as ToolLike[]).filter((t) => toolName(t) !== name);
		if ((payload.tools as ToolLike[]).length !== before) {
			activity(`stripped tool=${name} from non-target payload`);
		}
	};

	/**
	 * 注册与「声明给模型」分离。
	 *
	 * 之前是在 session_start 里按「当时的模型」注册 str_replace_editor，而 session_start 只在会话
	 * 创建/替换（以及 /reload）时触发一次，切换模型不会重跑——于是「启动在非目标模型上、之后再切到
	 * 目标模型」的会话永远拿不到这个引导工具，before_provider_request 只能 fail-safe。
	 *
	 * 现在：扩展加载时无条件注册（defaultActive:false，默认不声明给任何模型），是否声明由
	 * before_agent_start 按当前模型逐轮决定——pi 官方的 dynamic tools 模式。
	 */
	try {
		registerEditorTool(pi);
	} catch {
		/* 忽略：工具注册失败不应中断会话 */
	}

	/** 本扩展自己声明过 str_replace_editor 吗？只撤回自己加的那个，不动用户显式启用的。 */
	let editorActivatedByUs = false;

	/** 目标模型才把 str_replace_editor 声明给模型；非目标模型不声明。幂等：状态未变就不碰 loadout。 */
	function syncEditorActivation(ctx: {
		cwd: string;
		isProjectTrusted(): boolean;
		model?: { id: string; provider: string };
	}): void {
		const cfg = resolveConfig(loadRawConfig(ctx.cwd, ctx.isProjectTrusted()));
		const model = ctx.model;
		const wanted = Boolean(cfg.enabled && model && modelMatches(model.id, model.provider, cfg.models));
		const active = pi.getActiveTools?.() ?? [];
		const declared = active.includes(EDITOR_TOOL_NAME);
		if (wanted) {
			if (declared) return;
			pi.setActiveTools?.([...active, EDITOR_TOOL_NAME]);
			editorActivatedByUs = true;
			activity(`editor-declared for target model ${model?.provider}/${model?.id}`);
			return;
		}
		// 非目标模型：只撤回本扩展自己声明的，避免与用户显式的 --tools / defaultTools 打架
		if (declared && editorActivatedByUs) {
			pi.setActiveTools?.(active.filter((name) => name !== EDITOR_TOOL_NAME));
			editorActivatedByUs = false;
			activity("editor-withdrawn (non-target model)");
		}
	}

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
			// native（enabled:false）= 零介入：不改 persona、不动工具目录、不封顶。
			// 放在 modelMatches 之前——它与“是不是目标模型”无关。
			if (!cfg.enabled) {
				activity(`req model=${provider}/${modelId} → disabled (enabled=false: host request kept)`);
				return;
			}
			if (!modelMatches(modelId, provider, cfg.models)) {
				// 非目标模型：隐藏自定义引导工具（应对会话中途切到非目标模型的情况）
				stripToolFromPayload(payload, EDITOR_TOOL_NAME);
				activity(`req model=${provider}/${modelId} → not-targeted (models=${cfg.models.join(",")})`);
				return;
			}

			// 子代理豁免：无 UI 上下文的会话（ctx.hasUI === false）跳过预热，始终全目录 + 自己的系统提示词
			if (cfg.exemptSubagents && ctx.hasUI === false) {
				const subSid = ctx.sessionManager?.getSessionId?.() ?? "";
				activity(`req model=${provider}/${modelId} session=${subSid} → subagent-exempt (full catalog)`);
				return;
			}

			// ── 识别 payload 的 API 格式，分流到对应 adapter（anthropic-messages / openai-chat）──
			const adapter = getAdapter(payload);
			if (!adapter) {
				activity(
					`req model=${provider}/${modelId} → unknown payload format (system=${JSON.stringify(payload.system)?.slice(0, 40)}), skipping`,
				);
				return;
			}

			const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [];
			const sid = ctx.sessionManager?.getSessionId?.() ?? "";
			const historyPromoted = isPromoted(adapter, payload, cfg.promoteOn);
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

			// 无条件：每个请求第一行记录模型 + 实际工具名 + 消息数 + 识别出的格式（fail-safe/异常也看得见）
			const payloadTools = Array.isArray(payload.tools) ? (payload.tools as ToolLike[]) : [];
			const toolNames = payloadTools.map((t) => toolName(t) ?? "").filter(Boolean);
			activity(
				`req model=${provider}/${modelId} session=${sid} fmt=${adapter.format} tools=[${toolNames.join(",")}] ` +
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
				const sysText = adapter.getSystemText(payload);
				if (typeof sysText === "string" && sysText.length > 0) {
					originalPrompts.set(sid, sysText);
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
					const p = applyPromptMode(adapter, out, cfg.bootstrapPrompt, cfg.bootstrapTools);
					if (p.changed) {
						out = p.payload;
						changed = true;
					}
				}
				// 剥离注入的输出预算上限，恢复宿主默认
				const capped = capMaxTokens(adapter, out, cfg.bootstrapMaxTokens, true);
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

			// 1) 工具目录（fail-safe：缺引导工具则整个引导都不做，保持宿主原生请求）
			//    必须在改 persona 之前判定：否则会留下「minimal persona + 全量工具目录」这种两不像状态
			//    —— 既不是验证过的 Minimal 条件，也不是验证过的 native 基线。
			const tools = payload.tools as ToolLike[] | undefined;
			let filteredTools: ToolLike[] | undefined;
			if (Array.isArray(tools) && tools.length > 0) {
				const names = tools.map((t) => toolName(t)).filter((n): n is string => typeof n === "string");
				const { missing } = resolveBootstrap(names, cfg.bootstrapTools);
				if (missing.length > 0) {
					const warn = `[anchored-tools] bootstrap tools missing from catalog: ${missing.join(", ")}; skipping bootstrap (native request kept)`;
					activity(`fail-safe: ${warn}`);
					console.warn(warn);
					return;
				}
				const filtered = filterTools(tools, cfg.bootstrapTools);
				if (filtered.changed) filteredTools = filtered.tools as ToolLike[];
			}

			// 2) 系统提示词
			const prompt = applyPromptMode(adapter, next, cfg.bootstrapPrompt, cfg.bootstrapTools);
			if (prompt.changed) next = prompt.payload;
			if (filteredTools) next = { ...next, tools: filteredTools };

			// 3) 输出预算封顶（可选）
			const capped = capMaxTokens(adapter, next, cfg.bootstrapMaxTokens, false);
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
		// 每轮开始前同步 str_replace_editor 的声明状态。pi 在 before_agent_start 之后才组装本轮的
		// systemPrompt 与 tool loadout，所以这里 setActiveTools() 对同一次请求即生效。
		try {
			syncEditorActivation(ctx);
		} catch {
			/* 忽略：同步失败不影响本轮请求，下面照常做上下文注回 */
		}
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

	registerAnchoredToolsCommand(pi);
}
