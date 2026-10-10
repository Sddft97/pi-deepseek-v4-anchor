#!/usr/bin/env node
/**
 * 发版第一步（也是唯一一步手敲的命令）：
 *
 *   npm run release -- patch          # 或 minor | major | 1.2.3
 *   npm run release -- patch --dry-run
 *
 * 在干净且与 origin/main 同步的 main 上：把 `[Unreleased]` 收进 `## [X.Y.Z] - 日期`、
 * bump 版本号（package.json + package-lock 的两个根 version 字段）、推 `release/X.Y.Z`、
 * 开 release PR。合并之后由 CI 接手：自动打 tag（`.github/workflows/release.yml`）并
 * 用 provenance 发布到 npm。
 *
 * 设计上只做机械动作：不判断该发 patch 还是 minor —— 那是人的决定，用参数表达。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { collectUnreleased, localDate, nextVersion } from "./changelog.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const bump = argv.find((a) => !a.startsWith("-")) ?? "patch";

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const shell = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { stdio: "inherit", ...opts });

// ── 前置检查：发版是有副作用的动作，宁可在本地就拦住 ──────────────────────────
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
	fail("请在 main 上运行：release 分支要从 main 切出");
}
if (git("status", "--porcelain") !== "") {
	fail("工作区不干净：先提交或 stash");
}
git("fetch", "origin", "main");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
	fail("main 与 origin/main 不一致：先 `git pull --ff-only`");
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = nextVersion(pkg.version, bump);
const branch = `release/${version}`;

if (git("tag", "--list", `v${version}`)) fail(`本地已有 tag v${version}`);
// ls-remote 在不匹配时退出码非 0（execFileSync 会抛），所以包一层
try {
	const remoteTag = git("ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`);
	if (remoteTag) fail(`origin 已有 tag v${version}`);
} catch (err) {
	if (err.status !== 2) throw err; // 2 = 没有匹配的 ref
}
if (git("branch", "--list", branch)) fail(`本地已有分支 ${branch}`);

const date = localDate();
const changelog = collectUnreleased(readFileSync("CHANGELOG.md", "utf8"), version, date);
if (!changelog.hasContent) {
	fail("[Unreleased] 是空的：没有可发布的内容（先合并功能 PR）");
}

console.log(`发布 ${pkg.version} → ${version}（${date}）`);
if (dryRun) {
	console.log("--- dry-run：只会做以下动作，不会改动仓库 ---");
	console.log(`  1. git checkout -b ${branch}`);
	console.log(`  2. 写 CHANGELOG.md（[Unreleased] → [${version}]）`);
	console.log(`  3. npm version ${version} --no-git-tag-version`);
	console.log(`  4. git commit -m "chore(release): ${version}"`);
	console.log(`  5. git push -u origin ${branch}`);
	console.log(`  6. gh pr create --base main --head ${branch}`);
	console.log("--- CHANGELOG.md 前 12 行预览 ---");
	console.log(changelog.content.split("\n").slice(0, 12).join("\n"));
	process.exit(0);
}

git("checkout", "-b", branch);
writeFileSync("CHANGELOG.md", changelog.content);
shell("npm", ["version", version, "--no-git-tag-version"], { stdio: "pipe" });
git("add", "CHANGELOG.md", "package.json", "package-lock.json");
git("commit", "-m", `chore(release): ${version}`);
git("push", "-u", "origin", branch);

const body = [
	`## Release ${version}`,
	"",
	`- collected \`[Unreleased]\` into \`## [${version}] - ${date}\``,
	"- bumped `package.json` (plus both root `version` fields in `package-lock.json`)",
	"- no code changes",
	"",
	"Merging this is the release: `.github/workflows/release.yml` tags `v" +
		version +
		"` and publishes to npm with provenance.",
	"",
	`Manual fallback: \`git tag v${version} && git push origin main --tags\`.`,
	"",
].join("\n");

shell("gh", [
	"pr", "create",
	"--base", "main",
	"--head", branch,
	"--title", `chore(release): ${version}`,
	"--body", body,
]);
