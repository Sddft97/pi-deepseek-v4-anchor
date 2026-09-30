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

test("modelMatches: globs, provider-qualified globs, and /regex/ patterns", () => {
  const m = C.modelMatches;
  // existing glob behaviour is unchanged
  assert.equal(m("deepseek-v4-flash", "bai", ["deepseek-v4-flash"]), true);
  assert.equal(m("deepseek-v4-flash", "bai", ["deepseek-v4-pro"]), false);
  assert.equal(m("deepseek-v4-pro", "x", ["deepseek-v4-*"]), true);
  assert.equal(m("deepseek/deepseek-v4.1-flash", "openrouter-siliconflow", ["openrouter-siliconflow/*"]), true);
  // a bare glob cannot match a provider-prefixed id (anchored ^...$)
  assert.equal(m("deepseek/deepseek-v4.1-flash", "openrouter-siliconflow", ["deepseek-v4.1-flash"]), false);
  // regex is tested against both bare id and provider/id, so prefixes are transparent
  assert.equal(m("deepseek/deepseek-v4.1-flash", "openrouter-siliconflow", ["/deepseek.*flash/i"]), true);
  assert.equal(m("deepseek-v4-flash", "bai", ["/deepseek.*flash/i"]), true);
  assert.equal(m("deepseek-v4-pro", "x", ["/deepseek.*flash/i"]), false);
  // invalid regex falls back to glob (never throws)
  assert.equal(m("deepseek-v4-flash", "bai", ["/[/"]), false);
});

test("parseRegexPattern / matchPattern split regex from glob", () => {
  assert.deepEqual(C.parseRegexPattern("/foo.*bar/i"), { source: "foo.*bar", flags: "i" });
  assert.equal(C.parseRegexPattern("foo*bar"), undefined);
  assert.equal(C.parseRegexPattern("/[/"), undefined); // invalid regex
  assert.equal(C.matchPattern("/^a.c$/", "abc"), true);
  assert.equal(C.matchPattern("a*c", "abc"), true);
});

test("DEFAULT_MODELS covers future DeepSeek flash/pro names", () => {
  assert.deepEqual(C.DEFAULT_MODELS, ["/deepseek.*(flash|pro)/i"]);
  assert.equal(C.modelMatches("deepseek/deepseek-v4.1-flash", "openrouter-siliconflow", C.DEFAULT_MODELS), true);
  assert.equal(C.modelMatches("deepseek-v4-pro", "bai", C.DEFAULT_MODELS), true);
  assert.equal(C.modelMatches("deepseek/deepseek-r1", "openrouter", C.DEFAULT_MODELS), false);
});

test("Target-models menu discovers DeepSeek models from the registry", async () => {
  const { events } = instantiate();
  const seen = [];
  const script = [
    "\u2699\ufe0f Advanced settings",
    (opts) => opts.find((o) => o.startsWith("\ud83c\udf9b")),
    "\u2705 Done",
    "\ud83d\udd19 Back",
    undefined,
  ];
  let step = 0;
  const ctx = {
    ...mkCtx("menu1", "deepseek-v4.1-flash"),
    modelRegistry: {
      getAvailable: () => [
        { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter-siliconflow" },
        { id: "deepseek-v4-flash", provider: "bai" },
        { id: "gpt-5", provider: "openai" },
      ],
      getAll: () => [],
    },
    ui: {
      setStatus: () => {},
      notify: () => {},
      select: async (title, options) => {
        seen.push({ title, options: [...options] });
        const s = script[step++];
        return typeof s === "function" ? s(options) : s;
      },
    },
  };
  await events["cmd:anchored-tools"].handler("", ctx);
  const menu = seen.find((s) => s.title.startsWith("Target models"));
  assert.ok(menu, "models menu should open");
  assert.ok(menu.options.some((o) => o.includes("deepseek/deepseek-v4.1-flash")));
  assert.ok(menu.options.some((o) => o.includes("bai/deepseek-v4-flash")));
  assert.ok(!menu.options.some((o) => o.includes("gpt-5")));
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

// ────────────────────────────────────────────────────────────────────────────
// v4.2: anthropic-messages payload 格式支持（system 内容块数组 / tool_use）
// ────────────────────────────────────────────────────────────────────────────

test("format detection: system array → anthropic-messages, string → openai-chat", () => {
  assert.equal(C.detectPayloadFormat({ system: [{ type: "text", text: "S" }] }), "anthropic-messages");
  assert.equal(C.detectPayloadFormat({ system: "S" }), "openai-chat");
  assert.equal(C.detectPayloadFormat({ messages: [{ role: "system", content: "S" }] }), "openai-chat");
  assert.equal(C.detectPayloadFormat({ messages: [{ role: "user", content: "q" }] }), "unknown");
});

test("anthropic-messages payload: first request bootstraps (system array → minimal persona)", async () => {
  const { events } = instantiate();
  const ctx = mkCtx("a1");
  const out = await runRequest(events, {
    model: "deepseek-v4-pro",
    max_tokens: 64000,
    system: [{ type: "text", text: "You are pi. Available tools: ...", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    tools: [
      { name: "bash", description: "d", input_schema: { type: "object" } },
      { name: "read", description: "d", input_schema: { type: "object" } },
      { name: "str_replace_editor", description: "d", input_schema: { type: "object" } },
    ],
  }, ctx);
  assert.equal(out.system[0].text, "You are a helpful software engineer assistant.");
  assert.equal(out.system[0].cache_control.type, "ephemeral"); // 非 text 属性保留
  assert.deepEqual(out.tools.map((t) => t.name).sort(), ["bash", "str_replace_editor"]);
  assert.equal(out.max_tokens, 1024);
});

test("anthropic-messages payload: tool_use history promotes to full catalog", async () => {
  const { events } = instantiate();
  const ctx = mkCtx("a2");
  await runRequest(events, {
    model: "deepseek-v4-pro",
    system: [{ type: "text", text: "S" }],
    messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    tools: [{ name: "bash", description: "d", input_schema: { type: "object" } }],
  }, ctx);
  const p2 = {
    model: "deepseek-v4-pro",
    system: [{ type: "text", text: "S" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ],
    tools: [
      { name: "bash", description: "d", input_schema: { type: "object" } },
      { name: "read", description: "d", input_schema: { type: "object" } },
    ],
  };
  const out2 = await runRequest(events, p2, ctx);
  assert.equal(out2 === undefined || out2.tools.length === 2, true);
});

test("promoteOn tool-call detects anthropic tool_use content blocks", () => {
  const adapter = C.getAdapter({ system: [{ type: "text", text: "S" }] });
  assert.ok(adapter);
  assert.equal(
    C.isPromoted(adapter, { messages: [{ role: "assistant", content: [{ type: "tool_use", name: "bash" }] }] }, "tool-call"),
    true,
  );
  assert.equal(C.isPromoted(adapter, { messages: [{ role: "user", content: [] }] }, "tool-call"), false);
});

test("context reinject captures the original prompt from an anthropic system array", async () => {
  const { events } = instantiate();
  const ctx = mkCtx("a4");
  const sysText = "You are pi. Full context.";
  await runRequest(events, {
    model: "deepseek-v4-pro",
    system: [{ type: "text", text: sysText }],
    messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    tools: [
      { name: "bash", description: "d", input_schema: { type: "object" } },
      { name: "str_replace_editor", description: "d", input_schema: { type: "object" } },
    ],
  }, ctx);
  const entries = [
    { message: { role: "user", content: [{ type: "text", text: "q" }] } },
    { message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
    { message: { role: "toolResult", toolName: "bash" } },
  ];
  const out = await events.before_agent_start(
    { type: "before_agent_start", prompt: "hello", images: [], systemPrompt: "x", systemPromptOptions: {} },
    { ...ctx, sessionManager: { getSessionId: () => "a4", buildContextEntries: () => entries } },
  );
  assert.equal(out.message.customType, "anchored-context");
  assert.equal(out.message.content, sysText);
  assert.equal(out.message.display, false);
});

test("log helpers create the tmp dir and append lines", async () => {
  const logNs = await jiti.import("../src/log.ts");
  const line = "test-" + Date.now();
  logNs.appendLine(logNs.MARKER_PATH, line);
  const content = readFileSync(logNs.MARKER_PATH, "utf8");
  assert.ok(content.includes(line));
});

// ──────────────────────────────────────────────────────────────────────────
// Target models 菜单新语义：勾=生效态、行为由来源决定（规则区 + 模型区）
// ──────────────────────────────────────────────────────────────────────────

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function writeSettings(at) {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ anchoredTools: { locale: "en", ...at } }, null, 2) + "\n");
  return () => JSON.parse(readFileSync(SETTINGS_PATH, "utf8")).anchoredTools ?? {};
}

function menuHarness({ registry, pick, input }) {
  const selects = [];
  const notifications = [];
  const ctx = {
    ...mkCtx("menu-semantic"),
    ...(registry ? { modelRegistry: registry } : {}),
    ui: {
      setStatus: () => {},
      notify: (msg, level) => notifications.push({ msg, level }),
      input: async () => input,
      select: async (title, options) => {
        selects.push({ title, options: [...options] });
        return pick(selects.length, title, options);
      },
    },
  };
  return { ctx, selects, notifications, run: () => instantiate().events["cmd:anchored-tools"].handler("", ctx) };
}

// 常用退出脚本片段：models Done → advanced Back → top Esc
const EXIT = ["\u2705 Done", "\ud83d\udd19 Back", undefined];

const DS_REGISTRY = {
  getAvailable: () => [
    { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter-siliconflow" },
    { id: "deepseek-v4-flash", provider: "bai" },
    { id: "deepseek/deepseek-r1", provider: "openrouter" },
    { id: "gpt-5", provider: "openai" },
  ],
  getAll: () => [],
};

test("matchingPattern / isExactPattern: first hit + exact detection", () => {
  assert.equal(C.matchingPattern("deepseek-v4-flash", "bai", ["/deepseek.*flash/i"]), "/deepseek.*flash/i");
  assert.equal(C.matchingPattern("deepseek-v4-flash", "bai", ["other", "deepseek-v4-flash"]), "deepseek-v4-flash");
  assert.equal(C.matchingPattern("deepseek-v4-flash", "bai", ["deepseek-v4-pro"]), undefined);
  assert.equal(C.matchingPattern("deepseek/deepseek-v4.1-flash", "openrouter", ["openrouter/*"]), "openrouter/*");
  assert.equal(C.isExactPattern("deepseek-v4-flash"), true);
  assert.equal(C.isExactPattern("bai/deepseek-v4-flash"), true);
  assert.equal(C.isExactPattern("*deepseek-v4*"), false);
  assert.equal(C.isExactPattern("/deepseek.*/"), false);
});

test("menu: box = manual state; rule coverage shown as 📜 suffix; click is uniform toggle", async () => {
  const read = writeSettings({}); // default models = ["/deepseek.*(flash|pro)/i"]
  const h = menuHarness({
    registry: DS_REGISTRY,
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      if (n === 3) return options.find((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash"));
      return EXIT[n - 4];
    },
  });
  await h.run();
  const menu = h.selects.find((s) => s.title.startsWith("Target models"));
  assert.ok(menu, "models menu opened");
  // 标题按实际生效计数（DS_REGISTRY 发现 3 个，规则命中 2 个）
  assert.match(menu.title, /\(2\/3 anchored\)/);
  // 规则区：命中数标注
  assert.ok(menu.options.some((o) => o.includes("\ud83d\udcdc") && o.includes("(2 matched)")), String(menu.options));
  // 被规则覆盖：框=☐（无手动条目）+ 📜 后缀
  const flash = menu.options.find((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash"));
  assert.match(flash, /^\u2610 \ud83d\udcdc /);
  // 未被任何规则命中：☐ 且无 📜
  const r1 = menu.options.find((o) => o.includes("openrouter/deepseek/deepseek-r1"));
  assert.match(r1, /^\u2610 [^\ud83d]/);
  assert.doesNotMatch(r1, /\ud83d\udcdc/);
  // 点击规则覆盖的模型 = 统一手动开关：加显式条目（provider 限定）
  assert.deepEqual(read().models, ["/deepseek.*(flash|pro)/i", "openrouter-siliconflow/deepseek/deepseek-v4.1-flash"]);
  // 重绘：☑ + 📜（手动 + 规则覆盖同时存在）
  const redraw = h.selects[3];
  const flash2 = redraw.options.find((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash"));
  assert.match(flash2, /^\u2611 \ud83d\udcdc /);
});

test("menu: turning an off model on writes a provider-qualified exact pattern", async () => {
  const read = writeSettings({});
  const h = menuHarness({
    registry: DS_REGISTRY,
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      if (n === 3) return options.find((o) => o.includes("openrouter/deepseek/deepseek-r1"));
      return EXIT[n - 4];
    },
  });
  await h.run();
  assert.deepEqual(read().models, ["/deepseek.*(flash|pro)/i", "openrouter/deepseek/deepseek-r1"]);
  // 重绘后：☑ 手动开（r1 不被规则覆盖 → 无 📜）
  const redraw = h.selects[3];
  const r1 = redraw.options.find((o) => o.includes("openrouter/deepseek/deepseek-r1"));
  assert.match(r1, /^\u2611 [^\ud83d]/);
});

test("menu: explicit toggle-off removes entry; redraw shows \u2610 \ud83d\udcdc when rule still covers", async () => {
  const read = writeSettings({
    models: ["/deepseek.*flash/i", "openrouter-siliconflow/deepseek/deepseek-v4.1-flash"],
  });
  const h = menuHarness({
    registry: DS_REGISTRY,
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      if (n === 3) return options.find((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash"));
      return EXIT[n - 4];
    },
  });
  await h.run();
  assert.deepEqual(read().models, ["/deepseek.*flash/i"]);
  // 不再有 stillCovered 提示（📜 图标自解释）
  assert.ok(!h.notifications.some((x) => x.msg.includes("still matched")));
  // 重绘：手动关但规则仍覆盖 → ☐ 📜
  const redraw = h.selects[3];
  const entry = redraw.options.find((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash"));
  assert.match(entry, /^\u2610 \ud83d\udcdc /);
});

test("menu: exact entries adsorb into models section; last-model guard fires", async () => {
  const read = writeSettings({ models: ["bai/deepseek-v4-flash"] });
  const h = menuHarness({
    registry: DS_REGISTRY,
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      if (n === 3) return options.find((o) => o.includes("bai/deepseek-v4-flash"));
      return EXIT[n - 4];
    },
  });
  await h.run();
  const menu = h.selects[2];
  const entry = menu.options.find((o) => o.includes("bai/deepseek-v4-flash"));
  assert.match(entry, /^\u2611 [^\ud83d]/); // 手动开、无宽规则 → 无 📜
  // 规则区常驻但无规则条目，只剩 ➕ 入口
  assert.ok(!menu.options.some((o) => o.includes("\ud83d\udcdc")));
  assert.ok(menu.options.some((o) => o.includes("\u2795")));
  // 关闭唯一条目触发守卫，配置不变
  assert.deepEqual(read().models, ["bai/deepseek-v4-flash"]);
  assert.ok(h.notifications.some((x) => x.msg.includes("at least one target model")));
});

test("menu: rule submenu — disable parks in disabledModels, enable restores, delete removes", async () => {
  // 停用
  {
    const read = writeSettings({ models: ["/deepseek.*flash/i", "/deepseek-r1/"] });
    const h = menuHarness({
      registry: DS_REGISTRY,
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\ud83d\udcdc") && o.includes("/deepseek-r1/"));
        if (n === 4) return options.find((o) => o.includes("Disable"));
        return EXIT[n - 5];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*flash/i"]);
    assert.deepEqual(read().disabledModels, ["/deepseek-r1/"]);
  }
  // 启用（停用条目显示 ⏸，子菜单提供 Enable）
  {
    const read = writeSettings({ models: ["/deepseek.*flash/i"], disabledModels: ["/deepseek-r1/"] });
    const h = menuHarness({
      registry: DS_REGISTRY,
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\u23f8") && o.includes("/deepseek-r1/"));
        if (n === 4) return options.find((o) => o.includes("Enable"));
        return EXIT[n - 5];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*flash/i", "/deepseek-r1/"]);
    assert.deepEqual(read().disabledModels, []);
  }
  // 彻底删除
  {
    const read = writeSettings({ models: ["/deepseek.*flash/i", "/deepseek-r1/"] });
    const h = menuHarness({
      registry: DS_REGISTRY,
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\ud83d\udcdc") && o.includes("/deepseek-r1/"));
        if (n === 4) return options.find((o) => o.includes("Delete"));
        return EXIT[n - 5];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*flash/i"]);
    assert.deepEqual(read().disabledModels, []);
  }
  // 删除生效区最后一条 → 守卫
  {
    const read = writeSettings({ models: ["/deepseek.*flash/i"] });
    const h = menuHarness({
      registry: DS_REGISTRY,
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\ud83d\udcdc") && o.includes("/deepseek.*flash/i"));
        if (n === 4) return options.find((o) => o.includes("Delete"));
        return EXIT[n - 5];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*flash/i"]);
    assert.ok(h.notifications.some((x) => x.msg.includes("at least one target model")));
  }
});

test("menu: rule submenu — edit replaces the pattern in place", async () => {
  const read = writeSettings({ models: ["/deepseek.*flash/i", "/deepseek-r1/"] });
  const h = menuHarness({
    registry: DS_REGISTRY,
    input: "/deepseek-r2/",
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      if (n === 3) return options.find((o) => o.includes("\ud83d\udcdc") && o.includes("/deepseek-r1/"));
      if (n === 4) return options.find((o) => o.includes("Edit"));
      return EXIT[n - 5];
    },
  });
  await h.run();
  assert.deepEqual(read().models, ["/deepseek.*flash/i", "/deepseek-r2/"]);
});

test("menu: add-rule persists, validates, and auto-enables disabled rules", async () => {
  // 成功添加：重绘显示命中数
  {
    const read = writeSettings({});
    const h = menuHarness({
      registry: DS_REGISTRY,
      input: "/deepseek-r1/",
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\u2795"));
        return EXIT[n - 4];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*(flash|pro)/i", "/deepseek-r1/"]);
    assert.deepEqual(read().disabledModels, []);
    const redraw = h.selects[3];
    assert.ok(redraw.options.some((o) => o.includes("\ud83d\udcdc /deepseek-r1/ (1 matched)")), String(redraw.options));
  }
  // 输入停用区已有的规则 → 自动启用而非报重复
  {
    const read = writeSettings({ models: ["/deepseek.*flash/i"], disabledModels: ["/deepseek-r1/"] });
    const h = menuHarness({
      registry: DS_REGISTRY,
      input: "/deepseek-r1/",
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\u2795"));
        return EXIT[n - 4];
      },
    });
    await h.run();
    assert.deepEqual(read().models, ["/deepseek.*flash/i", "/deepseek-r1/"]);
    assert.deepEqual(read().disabledModels, []);
  }
  // 重复（生效区）/ 非法正则 / 空输入 → 拒绝且不写入
  for (const [bad, want] of [
    ["/deepseek.*(flash|pro)/i", "rule already exists"],
    ["/[/", "invalid regex syntax"],
    [undefined, null],
  ]) {
    const read = writeSettings({});
    const h = menuHarness({
      registry: DS_REGISTRY,
      input: bad,
      pick: (n, title, options) => {
        if (n === 1) return "\u2699\ufe0f Advanced settings";
        if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
        if (n === 3) return options.find((o) => o.includes("\u2795"));
        return EXIT[n - 4];
      },
    });
    await h.run();
    assert.equal(read().models, undefined, `no write for input=${JSON.stringify(bad)}`);
    if (want) assert.ok(h.notifications.some((x) => x.msg.includes(want)));
  }
});

test("menu: discovery scope = DeepSeek \u222a rule matches (qwen appears, gpt-5 does not)", async () => {
  writeSettings({ models: ["/qwen.*/i"] });
  const registry = {
    getAvailable: () => [
      { id: "qwen3-max", provider: "alibaba" },
      { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter-siliconflow" },
      { id: "gpt-5", provider: "openai" },
    ],
    getAll: () => [],
  };
  const h = menuHarness({
    registry,
    pick: (n, title, options) => {
      if (n === 1) return "\u2699\ufe0f Advanced settings";
      if (n === 2) return options.find((o) => o.startsWith("\ud83c\udf9b"));
      return EXIT[n - 3];
    },
  });
  await h.run();
  const menu = h.selects.find((s) => s.title.startsWith("Target models"));
  // qwen3-max：deepseek 名称过滤不命中，但被 /qwen.*/ 命中 → 出现且 ☐ 📜（规则覆盖，无手动条目）
  const qwen = menu.options.find((o) => o.includes("alibaba/qwen3-max"));
  assert.ok(qwen, "qwen entry present");
  assert.match(qwen, /^\u2610 \ud83d\udcdc /);
  // 纯 DeepSeek 名称过滤：无规则命中也可见
  assert.ok(menu.options.some((o) => o.includes("openrouter-siliconflow/deepseek/deepseek-v4.1-flash")));
  assert.ok(!menu.options.some((o) => o.includes("gpt-5")));
});
