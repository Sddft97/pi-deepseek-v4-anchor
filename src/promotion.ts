/**
 * 晋升判定。两种输入：
 * - provider payload（经 PayloadAdapter 分流格式差异）
 * - pi 会话条目（buildContextEntries 格式，单一格式，无需 adapter）
 */
import type { PromoteOn } from "./config.js";
import type { PayloadAdapter } from "./format.js";

type PayloadMessage = { role?: string; tool_calls?: unknown; content?: unknown };

/** 消息历史里是否存在 assistant 消息（两种格式通用）。 */
export function hasAssistantMessage(payload: Record<string, unknown>): boolean {
	const messages = payload.messages;
	return Array.isArray(messages) && messages.some((m) => (m as PayloadMessage)?.role === "assistant");
}

/** payload 晋升判定：格式差异交给 adapter，策略（promoteOn）在这里组合。 */
export function isPromoted(
	adapter: PayloadAdapter,
	payload: Record<string, unknown>,
	promoteOn: PromoteOn,
): boolean {
	if (promoteOn === "never") return false; // 永不晋升（minimal 预设）
	if (promoteOn === "tool-call") return adapter.hasToolCallHistory(payload);
	if (promoteOn === "assistant-message") return hasAssistantMessage(payload);
	return adapter.hasToolCallHistory(payload) || hasAssistantMessage(payload);
}

// ────────────────────────────────────────────────────────────────────────────
// 会话条目（buildContextEntries）格式 —— pi 内部格式，单一形状
// ────────────────────────────────────────────────────────────────────────────

type Entry = { message?: { role?: string; content?: unknown[] } };

/** 会话条目：role=toolResult 或 content 里 type=toolCall。 */
export function hasToolCallHistoryEntries(entries: unknown[]): boolean {
	return (entries ?? []).some((e) => {
		const m = (e as Entry)?.message;
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
		return (entries ?? []).some((e) => (e as Entry)?.message?.role === "assistant");
	}
	return (
		hasToolCallHistoryEntries(entries) ||
		(entries ?? []).some((e) => (e as Entry)?.message?.role === "assistant")
	);
}
