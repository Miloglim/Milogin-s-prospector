import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BASELINE_PATH = path.join(SCRIPT_DIR, "architecture-baseline.json");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function readString(source, start, quote) {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
    index++;
  }
  return { value, end: index };
}

/**
 * A small lexical reader is sufficient here: architecture rules only need module
 * specifiers and ipcMain.handle calls. It ignores comments and string contents,
 * so comments cannot accidentally satisfy or evade a rule.
 */
export function tokenize(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const parsed = readString(source, index, char);
      tokens.push({ kind: "string", value: parsed.value });
      index = parsed.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++;
      tokens.push({ kind: "word", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punctuation", value: char });
    index++;
  }
  return tokens;
}

function nextSignificant(tokens, index) {
  return tokens[index + 1];
}

export function extractSpecifiers(source) {
  const tokens = tokenize(source);
  const specifiers = new Set();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "word") continue;
    if (token.value === "require" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
      specifiers.add(tokens[index + 2].value);
      continue;
    }
    if (token.value === "import") {
      const next = nextSignificant(tokens, index);
      if (next?.kind === "string") { specifiers.add(next.value); continue; }
      if (next?.value === "(" && tokens[index + 2]?.kind === "string") { specifiers.add(tokens[index + 2].value); continue; }
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ";"; cursor++) {
        if (tokens[cursor].value === "from" && tokens[cursor + 1]?.kind === "string") {
          specifiers.add(tokens[cursor + 1].value);
          break;
        }
      }
    }
    if (token.value === "export") {
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ";"; cursor++) {
        if (tokens[cursor].value === "from" && tokens[cursor + 1]?.kind === "string") {
          specifiers.add(tokens[cursor + 1].value);
          break;
        }
      }
    }
  }
  return [...specifiers];
}

export function hasIpcHandle(source) {
  const tokens = tokenize(source);
  return tokens.some((token, index) =>
    token.value === "ipcMain" && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "handle");
}

function hasPrefix(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function baselineKey(file, rule, specifier) {
  return `${file}|${rule}|${specifier}`;
}

export function validateBaseline(baseline, now = new Date()) {
  const errors = [];
  const entries = new Map();
  for (const exception of baseline.exceptions ?? []) {
    const key = baselineKey(exception.file, exception.rule, exception.specifier);
    if (entries.has(key)) errors.push(`重复的基线例外: ${key}`);
    entries.set(key, exception);
    if (!exception.ticket || !exception.reason || !exception.expires) {
      errors.push(`基线例外缺少 ticket/reason/expires: ${key}`);
      continue;
    }
    if (Number.isNaN(Date.parse(`${exception.expires}T00:00:00Z`))) {
      errors.push(`基线例外日期无效: ${key}`);
      continue;
    }
    if (Date.parse(`${exception.expires}T23:59:59Z`) < now.getTime()) {
      errors.push(`基线例外已到期: ${key} (${exception.expires})`);
    }
  }
  return { errors, entries };
}

function violation(file, rule, specifier, message) {
  return { file, rule, specifier, message };
}

export function inspectFile(file, source, baselineEntries, usedBaselineKeys = new Set()) {
  const specifiers = extractSpecifiers(source);
  const violations = [];
  const isTransport = hasPrefix(file, "src/main/transport");
  const isService = hasPrefix(file, "src/main/services");
  const isRenderer = hasPrefix(file, "src/renderer");

  for (const specifier of specifiers) {
    if (isTransport && hasPrefix(specifier, "../db")) {
      violations.push(violation(file, "transport-db", specifier, "transport 层不能直接依赖 DB/schema"));
    }
    if (isService && specifier === "electron") {
      violations.push(violation(file, "service-electron", specifier, "service 层不能依赖 Electron"));
    }
    if (isRenderer && (specifier.includes("/main/") || specifier === "../main" || specifier === "../../main")) {
      violations.push(violation(file, "renderer-main", specifier, "renderer 不能直接依赖 main 进程模块"));
    }
  }
  if (hasIpcHandle(source) && !isTransport) {
    violations.push(violation(file, "ipc-handler-location", "ipcMain.handle", "IPC handler 只能在 transport 层注册"));
  }

  return violations.filter(item => {
    const key = baselineKey(item.file, item.rule, item.specifier);
    if (!baselineEntries.has(key)) return true;
    usedBaselineKeys.add(key);
    return false;
  });
}

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".trash"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
    }
  };
  walk(root);
  return files;
}

export function runCheck({ root = REPO_ROOT, baselinePath = BASELINE_PATH, now } = {}) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const { errors, entries } = validateBaseline(baseline, now);
  const usedBaselineKeys = new Set();
  const files = listSourceFiles(path.join(root, "src"));
  for (const fullPath of files) {
    const relative = normalizePath(path.relative(root, fullPath));
    const source = fs.readFileSync(fullPath, "utf8");
    for (const item of inspectFile(relative, source, entries, usedBaselineKeys)) {
      errors.push(`${item.file}: ${item.message} (${item.specifier})`);
    }
  }
  for (const [key, exception] of entries) {
    if (!usedBaselineKeys.has(key)) {
      errors.push(`基线例外已不再命中，请删除: ${key} (${exception.ticket})`);
    }
  }
  return { errors, scannedFiles: files.length, baselineEntries: entries.size };
}

function main() {
  const result = runCheck();
  if (result.errors.length) {
    console.error("\\n❌ 架构边界检查失败:\\n" + result.errors.map(error => `- ${error}`).join("\\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 架构边界检查通过（扫描 ${result.scannedFiles} 个源码文件；登记 ${result.baselineEntries} 项待整改例外）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
