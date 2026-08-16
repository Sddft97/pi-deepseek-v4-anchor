import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Isolate all pi settings I/O to a temporary HOME so tests never touch the
// real user configuration and are portable across OSes (no USERPROFILE).
const tempHome = mkdtempSync(join(tmpdir(), "pi-dsv4a-test-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.on("exit", () => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

import { createJiti } from "jiti";

// Load the extension with jiti (the same loader pi uses). Imports of
// @earendil-works/pi-coding-agent and typebox resolve from this repo's
// node_modules (devDependencies).
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
});

async function load() {
  const ns = await jiti.import("../index.ts");
  const mod = { ...ns };
  const factory = typeof ns === "function" ? ns : ns.default ?? ns;
  return { mod, factory };
}

const { mod: C, factory } = await load();

function instantiate() {
  const events = {};
  const tools = [];
  factory({
    on: (name, handler) => {
      events[name] = handler;
    },
    registerCommand: (name, cmd) => {
      events[`cmd:${name}`] = cmd;
    },
    getAllTools: () => tools,
    registerTool: (tool) => tools.push(tool),
  });
  return { events, tools };
}

function mkCtx(sid, model = "deepseek-v4-pro") {
  return {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    model: { id: model, provider: "opencode-go" },
    sessionManager: { getSessionId: () => sid, buildContextEntries: () => [] },
    hasUI: true,
    ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
  };
}

function mkTools(names) {
  return names.map((n) => ({ type: "function", function: { name: n } }));
}

async function runRequest(events, payload, ctx) {
  const out = await events.before_provider_request({ type: "before_provider_request", payload }, ctx);
  return out === undefined ? payload : out;
}

test("default config: anchor preset, Minimal pair, 1024 max tokens, subagents bootstrap", () => {
  const cfg = C.resolveConfig(undefined);
  assert.equal(cfg.preset, "anchor");
  assert.deepEqual(cfg.bootstrapTools, ["bash", "str_replace_editor"]);
  assert.equal(cfg.bootstrapMaxTokens, 1024);
  assert.equal(cfg.exemptSubagents, false);
  assert.equal(cfg.contextReinject, true);
});

test("preset overrides and explicit null disables the max-token cap", () => {
  assert.equal(C.resolveConfig({ preset: "minimal" }).promoteOn, "never");
  assert.equal(C.resolveConfig({ bootstrapMaxTokens: null }).bootstrapMaxTokens, undefined);
  assert.equal(C.resolveConfig({ bootstrapMaxTokens: 2048 }).bootstrapMaxTokens, 2048);
});

test("toolName reads function.name, custom.name, and top-level name", () => {
  assert.equal(C.toolName({ type: "function", function: { name: "bash" } }), "bash");
  assert.equal(C.toolName({ type: "custom", custom: { name: "grammar-x" } }), "grammar-x");
  assert.equal(C.toolName({ name: "read" }), "read");
  assert.equal(C.toolName({}), undefined);
});

test("str_replace_editor is registered only for target-model sessions", async () => {
  const { events, tools } = instantiate();
  await events.session_start({ type: "session_start" }, mkCtx("s1", "deepseek-v4-pro"));
  assert.ok(tools.some((t) => t.name === "str_replace_editor"));

  const { events: ev2, tools: tools2 } = instantiate();
  await ev2.session_start({ type: "session_start" }, mkCtx("s2", "claude-sonnet"));
  assert.ok(!tools2.some((t) => t.name === "str_replace_editor"));
});

test("str_replace_editor view/create/str_replace/insert work over local fs", async () => {
  const { events, tools } = instantiate();
  await events.session_start({ type: "session_start" }, mkCtx("s3", "deepseek-v4-pro"));
  const ed = tools.find((t) => t.name === "str_replace_editor");
  assert.ok(ed);

  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "as-test-"));
  const file = join(dir, "test.txt");
  writeFileSync(file, "line1\nline2\nline3\n", "utf-8");
  const run = async (args) => (await ed.execute("c1", args, undefined, () => {}, {})).content[0].text;

  assert.match(await run({ command: "view", path: file }), /line1/);
  assert.match(await run({ command: "str_replace", path: file, old_str: "line2", new_str: "LINE2" }), /edited successfully/);
  assert.ok(readFileSync(file, "utf-8").includes("LINE2"));
  await run({ command: "insert", path: file, insert_line: 1, new_str: "X" });
  assert.ok(readFileSync(file, "utf-8").split("\n").includes("X"));
  assert.equal(
    await run({ command: "create", path: join(dir, "new.txt"), file_text: "hi" }),
    "New file created successfully at: " + join(dir, "new.txt"),
  );
  await assert.rejects(() => run({ command: "str_replace", path: file, old_str: "NOTHERE", new_str: "x" }), /did not appear verbatim/);
  rmSync(dir, { recursive: true, force: true });
});

test("first request bootstraps to bash+str_replace_editor and injects max_tokens=1024", async () => {
  const { events } = instantiate();
  const ctx = mkCtx("s4");
  const out = await runRequest(events, {
    model: "deepseek-v4-pro",
    max_tokens: 64000,
    messages: [{ role: "system", content: "S" }, { role: "user", content: "q" }],
    tools: mkTools(["bash", "read", "str_replace_editor", "ls"]),
  }, ctx);
  assert.deepEqual(out.tools.map((t) => t.function.name).sort(), ["bash", "str_replace_editor"]);
  assert.equal(out.max_tokens, 1024);
  assert.equal(out.messages[0].content, "You are a helpful software engineer assistant.");
});

test("promotion is sticky across compaction (history collapse does not re-anchor)", async () => {
  const { events } = instantiate();
  const ctx = mkCtx("s5");
  await runRequest(events, {
    model: "deepseek-v4-pro",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "q" }],
    tools: mkTools(["bash", "str_replace_editor", "ls"]),
  }, ctx);
  const p2 = {
    model: "deepseek-v4-pro",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "q" }, { role: "assistant", tool_calls: [{ id: "1" }] }],
    tools: mkTools(["bash", "str_replace_editor", "ls"]),
  };
  const out2 = await runRequest(events, p2, ctx);
  assert.equal(out2 === undefined || out2.tools.length === 3, true);
  const p3 = {
    model: "deepseek-v4-pro",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "(compacted summary)" }],
    tools: mkTools(["bash", "str_replace_editor", "ls"]),
  };
  const out3 = await runRequest(events, p3, ctx);
  assert.equal(out3 === undefined || out3.tools.length === 3, true);
});

test("non-target models never see str_replace_editor", async () => {
  const { events } = instantiate();
  const payload = {
    model: "claude-sonnet",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "q" }],
    tools: mkTools(["bash", "str_replace_editor", "ls"]),
  };
  const out = await runRequest(events, payload, mkCtx("s6", "claude-sonnet"));
  assert.equal(out, payload);
  assert.ok(!out.tools.some((t) => t.function.name === "str_replace_editor"));
});

test("interactive menu exposes completions with descriptions", () => {
  const { events } = instantiate();
  const cmd = events["cmd:anchored-tools"];
  assert.ok(cmd);
  const completions = cmd.getArgumentCompletions("");
  assert.ok(completions.some((x) => x.value === "preset anchor"));
  assert.ok(completions.every((x) => x.description));
});

test("i18n: default locale is en; zh config switches menu language", async () => {
  const cfg = C.resolveConfig(undefined);
  assert.equal(cfg.locale, "en");
  assert.equal(C.resolveConfig({ locale: "zh" }).locale, "zh");
  assert.equal(C.resolveConfig({ locale: "fr" }).locale, "en"); // invalid → en
});

test("i18n: language switch persists and re-renders menu in the new locale", async () => {
  const { events } = instantiate();
  const cmd = events["cmd:anchored-tools"];
  const sp = join(homedir(), ".pi", "agent", "settings.json");
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  const sc = { anchoredTools: { enabled: true, preset: "anchor", locale: "en" } };
  writeFileSync(sp, JSON.stringify(sc, null, 2) + "\n");

  // top (en) -> Advanced -> Language -> 中文
  const ctx = mkCtx("i18n-1");
  const selects = [];
  ctx.ui.select = async (title, options) => {
    selects.push({ title, options });
    const step = selects.length;
    if (step === 1) return "⚙️ Advanced settings"; // top -> advanced
    if (step === 2) return options.find((o) => o.includes("Language")) ?? options[0]; // advanced -> language
    if (step === 3) return "中文"; // language menu -> zh
    return undefined;
  };
  await cmd.handler("", ctx);

  const after = JSON.parse(readFileSync(sp, "utf8")).anchoredTools;
  assert.equal(after.locale, "zh");

  const zhRendered = selects.some((s) => s.title.includes("语言"));
  assert.ok(zhRendered);
});
