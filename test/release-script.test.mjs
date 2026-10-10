import test from "node:test";
import assert from "node:assert/strict";

import { collectUnreleased, localDate, nextVersion } from "../scripts/changelog.mjs";

const FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Fixed",
	"",
	"- something fixed",
	"",
	"### Changed",
	"",
	"- something changed",
	"",
	"## [1.2.0] - 2026-10-01",
	"",
	"### Added",
	"",
	"- old entry",
	"",
].join("\n");

test("nextVersion: patch / minor / major / explicit", () => {
	assert.equal(nextVersion("1.2.1", "patch"), "1.2.2");
	assert.equal(nextVersion("1.2.1", "minor"), "1.3.0");
	assert.equal(nextVersion("1.2.1", "major"), "2.0.0");
	assert.equal(nextVersion("1.2.1", "1.5.0"), "1.5.0");
	assert.throws(() => nextVersion("1.2.1", "banana"), /unknown bump/);
	assert.throws(() => nextVersion("v1.2", "patch"), /not x\.y\.z/);
});

test("localDate formats the local date, not UTC", () => {
	assert.equal(localDate(new Date(2026, 0, 5, 8, 30)), "2026-01-05");
	// 本地 00:30（CST）时 UTC 还是前一天 —— 必须取本地
	assert.equal(localDate(new Date(2026, 0, 5, 0, 30)), "2026-01-05");
});

test("collectUnreleased moves [Unreleased] content under the new version", () => {
	const { content, hasContent } = collectUnreleased(FIXTURE, "1.2.1", "2026-10-10");
	assert.equal(hasContent, true);
	assert.match(content, /## \[Unreleased\]\n\n## \[1\.2\.1\] - 2026-10-10\n\n### Fixed\n\n- something fixed/);
	// 旧版本小节原样保留，且只出现一次新表头
	assert.match(content, /## \[1\.2\.0\] - 2026-10-01\n\n### Added\n\n- old entry/);
	assert.equal(content.match(/## \[1\.2\.1\]/g).length, 1);
	// 原有内容一行不少
	assert.ok(content.includes("- something changed"));
});

test("collectUnreleased reports an empty [Unreleased] so the caller can abort", () => {
	const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-01\n";
	const { hasContent, content } = collectUnreleased(empty, "1.2.1", "2026-10-10");
	assert.equal(hasContent, false);
	assert.match(content, /## \[Unreleased\]\n\n## \[1\.2\.1\] - 2026-10-10/);
});

test("collectUnreleased throws when there is no [Unreleased] section", () => {
	assert.throws(() => collectUnreleased("# Changelog\n", "1.2.1", "2026-10-10"), /no `## \[Unreleased\]`/);
});
