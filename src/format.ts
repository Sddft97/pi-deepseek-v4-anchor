/**
 * 格式层：识别 provider payload 的 API 格式，并通过 PayloadAdapter 接口
 * 把“格式相关的读写原语”与“格式无关的策略逻辑”解耦。
 *
 * 核心思路：先 detectPayloadFormat() 识别格式，再取出对应的 adapter，
 * 上层（index.ts 的状态机）只依赖 PayloadAdapter 接口，不再关心
 * system 是字符串还是内容块数组、工具调用是 tool_calls 还是 tool_use。
 *
 * 已知格式：
 * - "anthropic-messages"：system 为内容块数组 [{type:"text",text}]，assistant
 *   工具调用为 {type:"tool_use"} 内容块（pi 的 anthropic-messages / pi-messages 协议）。
 * - "openai-chat"：system 为字符串或 messages 里的 system 角色消息，assistant
 *   工具调用为 tool_calls 字段，工具结果为 role:"tool"（chat-completions 风格）。
 * - unknown：不认识的结构 → 上层跳过所有改写（fail-safe）。
 */
import type { BootstrapPrompt } from "./config.js";
import { MINIMAL_SYSTEM_PROMPT } from "./config.js";

// ────────────────────────────────────────────────────────────────────────────
// 格式识别
// ────────────────────────────────────────────────────────────────────────────

export type PayloadFormat = "anthropic-messages" | "openai-chat" | "unknown";

export function detectPayloadFormat(payload: Record<string, unknown>): PayloadFormat {
	const system = payload.system;
	if (Array.isArray(system)) return "anthropic-messages";
	if (typeof system === "string") return "openai-chat";
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		// system 缺失时兜底：system/developer 角色消息 → openai 风格
		if (
			messages.some(
				(m) =>
					m &&
					typeof m === "object" &&
					((m as { role?: string }).role === "system" || (m as { role?: string }).role === "developer"),
			)
		) {
			return "openai-chat";
		}
	}
	return "unknown";
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter 接口：格式相关的读写原语
// ────────────────────────────────────────────────────────────────────────────

export interface PayloadAdapter {
	readonly format: PayloadFormat;

	/** 读取系统提示词文本（无则 undefined）。 */
	getSystemText(payload: Record<string, unknown>): string | undefined;

	/** 整体替换系统提示词文本。已是目标文本时返回 changed:false（幂等）。 */
	setSystemText(
		payload: Record<string, unknown>,
		text: string,
	): { changed: boolean; payload: Record<string, unknown> };

	/** 消息历史里是否存在工具调用（用于晋升判定）。 */
	hasToolCallHistory(payload: Record<string, unknown>): boolean;

	/** 返回承载输出预算上限的字段名（无则 undefined），如 "max_tokens"。 */
	maxTokensField(payload: Record<string, unknown>): string | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// anthropic-messages 适配器（system = 内容块数组；tool_use 内容块）
// ────────────────────────────────────────────────────────────────────────────

/** 从 anthropic-messages 的 system 内容块数组里取第一个 text 块。 */
export function systemTextFromBlocks(system: unknown[]): { index: number; text: string } | undefined {
	const blocks = system as { type?: string; text?: string }[];
	const i = blocks.findIndex(
		(b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
	);
	if (i === -1) return undefined;
	return { index: i, text: blocks[i].text as string };
}

const anthropicAdapter: PayloadAdapter = {
	format: "anthropic-messages",

	getSystemText(payload) {
		const system = payload.system;
		if (Array.isArray(system)) return systemTextFromBlocks(system)?.text;
		if (typeof system === "string") return system; // 防御：字符串也读（不该出现）
		return undefined;
	},

	setSystemText(payload, text) {
		const system = payload.system;
		if (typeof system === "string") {
			if (system === text) return { changed: false, payload };
			return { changed: true, payload: { ...payload, system: text } };
		}
		if (Array.isArray(system)) {
			const found = systemTextFromBlocks(system);
			if (found) {
				if (found.text === text) return { changed: false, payload };
				const blocks = (system as { type?: string; text?: string }[]).slice();
				blocks[found.index] = { ...(blocks[found.index] as object), text };
				// 去掉多余 text 块，避免 persona 重复；保留非 text 块（如 cache_control 结构）
				const nextSystem = blocks.filter(
					(b, i) =>
						i === found.index ||
						!(b && typeof b === "object" && (b as { type?: string }).type === "text"),
				);
				return { changed: true, payload: { ...payload, system: nextSystem } };
			}
			// 数组里没有 text 块 → 补一个
			return { changed: true, payload: { ...payload, system: [...system, { type: "text", text }] } };
		}
		return { changed: false, payload };
	},

	hasToolCallHistory(payload) {
		const messages = payload.messages;
		if (!Array.isArray(messages)) return false;
		return messages.some((raw) => {
			const m = raw as { role?: string; content?: unknown };
			if (!m || typeof m !== "object") return false;
			if (m.role === "assistant" && Array.isArray(m.content)) {
				return m.content.some(
					(c) => c && typeof c === "object" && (c as { type?: string }).type === "tool_use",
				);
			}
			return false;
		});
	},

	maxTokensField(payload) {
		return typeof payload.max_tokens === "number" ? "max_tokens" : undefined;
	},
};

// ────────────────────────────────────────────────────────────────────────────
// openai-chat 适配器（system = 字符串 / system 角色消息；tool_calls 字段）
// ────────────────────────────────────────────────────────────────────────────

/** 找到 messages 里第一个 system/developer 消息。 */
export function findSystemMessage(
	messages: unknown[],
): { msg: { content?: unknown }; index: number } | undefined {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as { role?: string; content?: unknown } | null;
		if (m && typeof m === "object" && (m.role === "system" || m.role === "developer")) {
			return { msg: m as { content?: unknown }, index: i };
		}
	}
	return undefined;
}

const openaiAdapter: PayloadAdapter = {
	format: "openai-chat",

	getSystemText(payload) {
		if (typeof payload.system === "string") return payload.system;
		const found = findSystemMessage(
			Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [],
		);
		if (found && typeof found.msg.content === "string") return found.msg.content;
		return undefined;
	},

	setSystemText(payload, text) {
		if (typeof payload.system === "string") {
			if (payload.system === text) return { changed: false, payload };
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
	},

	hasToolCallHistory(payload) {
		const messages = payload.messages;
		if (!Array.isArray(messages)) return false;
		return messages.some((raw) => {
			const m = raw as { role?: string; tool_calls?: unknown; content?: unknown };
			if (!m || typeof m !== "object") return false;
			if (m.role === "tool") return true;
			if (m.role === "assistant") {
				if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
				if (Array.isArray(m.content)) {
					return m.content.some(
						(c) =>
							c && typeof c === "object" && (c as { type?: string }).type === "toolCall",
					);
				}
			}
			return false;
		});
	},

	maxTokensField(payload) {
		for (const field of ["max_tokens", "max_completion_tokens"]) {
			if (typeof payload[field] === "number") return field;
		}
		return undefined;
	},
};

/** 按 payload 结构识别格式并返回对应 adapter；未知格式返回 undefined（上层跳过）。 */
export function getAdapter(payload: Record<string, unknown>): PayloadAdapter | undefined {
	switch (detectPayloadFormat(payload)) {
		case "anthropic-messages":
			return anthropicAdapter;
		case "openai-chat":
			return openaiAdapter;
		default:
			return undefined;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// 工具目录（格式无关：三种序列化格式都能取到工具名）
// ────────────────────────────────────────────────────────────────────────────

type ToolLike = {
	name?: string;
	type?: string;
	function?: { name?: string };
	custom?: { name?: string };
};

export type { ToolLike };

/** 兼容三种序列化格式取工具名（anthropic {name} / openai {type:function} / pi custom）。 */
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
// 系统提示词改写策略（格式无关：通过 adapter 读写，文本操作集中在此）
// ────────────────────────────────────────────────────────────────────────────

const PROMPT_MARKERS = {
	start: "Available tools:",
	end: "In addition to the tools above",
} as const;

/** 把系统提示词文本里 "Available tools:" 清单裁剪为只保留引导工具（保留原 snippet）。 */
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

/** 按 bootstrapPrompt 模式改写 payload 里的系统提示词（策略与格式分离）。 */
export function applyPromptMode(
	adapter: PayloadAdapter,
	payload: Record<string, unknown>,
	mode: BootstrapPrompt,
	keepTools: string[],
): { changed: boolean; payload: Record<string, unknown> } {
	if (mode === "none") return { changed: false, payload };
	if (mode === "minimal") return adapter.setSystemText(payload, MINIMAL_SYSTEM_PROMPT);

	// trim：先取文本（格式无关），再裁剪，最后写回
	const text = adapter.getSystemText(payload);
	if (text === undefined) return { changed: false, payload };
	const trimmed = trimSystemPrompt(text, keepTools);
	if (trimmed === text) return { changed: false, payload };
	return adapter.setSystemText(payload, trimmed);
}

// ────────────────────────────────────────────────────────────────────────────
// 输出预算封顶（格式无关：字段名由 adapter 提供）
// ────────────────────────────────────────────────────────────────────────────

export function capMaxTokens(
	adapter: PayloadAdapter,
	payload: Record<string, unknown>,
	cap: number | undefined,
	promoted: boolean,
): { changed: boolean; payload: Record<string, unknown> } {
	if (cap === undefined) return { changed: false, payload };
	const field = adapter.maxTokensField(payload);
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
