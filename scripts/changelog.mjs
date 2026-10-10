/**
 * scripts/release.mjs 的纯逻辑部分 —— 单独放一个文件是为了能直接单测（不跑 git/gh）。
 */

/** 本地日期 YYYY-MM-DD。不用 toISOString()：那是 UTC，CST 深夜发版会差一天。 */
export function localDate(now = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `patch` | `minor` | `major` | 显式 `x.y.z` → 下一个版本号。 */
export function nextVersion(current, bump) {
	if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
	if (!m) throw new Error(`current version is not x.y.z: ${current}`);
	const major = Number(m[1]);
	const minor = Number(m[2]);
	const patch = Number(m[3]);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
	throw new Error(`unknown bump "${bump}" (use patch|minor|major|x.y.z)`);
}

/**
 * 把 `[Unreleased]` 下的内容收进新版本小节——即在其后插入 `## [version] - date`，
 * 保持内容原位（Keep a Changelog 的写法）。
 *
 * 返回 `{ content, hasContent }`；`hasContent` 为 false 表示 `[Unreleased]` 是空的，
 * 调用方应中止发版。
 */
export function collectUnreleased(markdown, version, date) {
	const HEADER = "## [Unreleased]";
	const at = markdown.indexOf(HEADER);
	if (at < 0) throw new Error("CHANGELOG.md has no `## [Unreleased]` section");
	const after = at + HEADER.length;
	const rest = markdown.slice(after);
	const nextHeader = rest.search(/\n## \[/);
	const body = nextHeader < 0 ? rest : rest.slice(0, nextHeader);
	const hasContent = /^###\s+\S/m.test(body) || /^-\s+\S/m.test(body);
	return {
		content: markdown.slice(0, after) + `\n\n## [${version}] - ${date}` + rest,
		hasContent,
	};
}
