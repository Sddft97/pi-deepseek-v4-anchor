/**
 * str_replace_editor：DSH Minimal 编辑器工具（pi 移植自 pi-deepseek-anchor / SeekAnchor）。
 * 仅由 index.ts 在目标模型会话的 session_start 里注册。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";

/** DSH Minimal str_replace_editor 工具描述（与官方 preset 逐字节一致，不得改写）。 */
const EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique`;

const EDITOR_TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

const EDITOR_MAX_OUTPUT_CHARS = 16000;

interface EditorArgs {
	command: "view" | "create" | "str_replace" | "insert";
	path: string;
	file_text?: string;
	insert_line?: number;
	new_str?: string;
	old_str?: string;
	view_range?: number[];
}

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
export function registerEditorTool(pi: ExtensionAPI): void {
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
