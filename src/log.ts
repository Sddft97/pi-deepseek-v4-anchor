/**
 * 日志：启动标记 / 活动日志 / 调试日志。
 * 目录不存在时自动创建（appendFileSync 不会创建父目录）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TMP_DIR = join(homedir(), ".pi", "agent", "tmp");

/** 启动标记：扩展每次加载追加一行。 */
export const MARKER_PATH = join(TMP_DIR, "anchored-loaded.log");
/** 调试日志（config.debug 或 PI_ANCHORED_DEBUG=1）。 */
export const DEBUG_LOG_PATH = join(TMP_DIR, "anchored-debug.log");
/** 无条件活动日志：每个请求的决策 + 异常，用于排查“为什么没生效”。 */
export const ACTIVITY_LOG_PATH = join(TMP_DIR, "anchored-activity.log");

export function appendLine(path: string, line: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`, "utf8");
	} catch {
		/* 日志失败不影响功能 */
	}
}

/** 无条件活动日志（每个请求调用一次，行数可控）。 */
export function activity(line: string): void {
	appendLine(ACTIVITY_LOG_PATH, line);
}
