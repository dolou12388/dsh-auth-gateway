/**
 * DSH 配置写入：provider、API Key、默认模型。
 *
 * 直接改两个文件，格式与 DSH 自己的设置页写出来的一致：
 *
 *   ~/.dsh/profiles/<name>/cordis.patch.yml   provider 定义 + 默认模型
 *   ~/.dsh/.credentials.yaml                  API Key（refs 段）
 *
 * 为什么直接写文件而不走 DSH 的接口：DSH 前端是走 WebSocket RPC 的，
 * 没有对外开放的 REST 写入口；而它的 patch 文件有 HMR 监听，写完即生效，
 * 不需要重启进程。
 *
 * 两个约束（写错了 DSH 会起不来）：
 *   1. patch 的 `config` 是**整行替换**，不列出的字段会退回代码默认值。
 *      所以改 provider 时必须把原有字段一并带上。
 *   2. credential 的 ref 名必须是 POSIX 标识符（[A-Za-z_][A-Za-z0-9_]*）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** patch 里我们管理的三个 entry id。 */
const ID_PROVIDER = "llm-pi-ai";
const ID_DEFAULT_MODEL = "agent-default-model";
const NAME_PROVIDER = "@deepseek-ai/dsh-llm-pi-ai";
const NAME_DEFAULT_MODEL = "@deepseek-ai/dsh-agent-default-model";

/** 我们写入的 provider 在 DSH 里的路由 id。 */
export const PROVIDER_ID = "custom";

export class DshConfigWriter {
  /**
   * @param {string} dshHome - DSH 主目录
   * @param {string} profileName - profile 名（一般是 "web"）
   */
  constructor(dshHome, profileName = "web") {
    this.dshHome = dshHome;
    this.profileName = profileName;
    this.patchPath = join(dshHome, "profiles", profileName, "cordis.patch.yml");
    this.credentialsPath = join(dshHome, ".credentials.yaml");
  }

  /**
   * 读取当前配置（给页面回显用）。
   *
   * @returns {Promise<{ baseURL?: string, model?: string, hasKey: boolean, provider?: string }>}
   */
  async read() {
    const patch = await this.#readPatch();
    const provider = findProvider(patch);
    const def = patch.find((e) => e.id === ID_DEFAULT_MODEL);
    const refs = await this.#readRefs();
    const refName = provider?.config?.providers?.[PROVIDER_ID]?.apiKeyEnv;
    return {
      baseURL: provider?.config?.providers?.[PROVIDER_ID]?.baseURL,
      model: def?.config?.model,
      provider: def?.config?.provider,
      hasKey: typeof refName === "string" && refs[refName] !== undefined,
    };
  }

  /**
   * 读取已保存的 API Key（明文）。
   *
   * 只给网关自己用（页面留空时沿用旧值）。不要回显到网页上。
   *
   * @returns {Promise<string | undefined>}
   */
  async readKey() {
    const patch = await this.#readPatch();
    const provider = findProvider(patch);
    const refName = provider?.config?.providers?.[PROVIDER_ID]?.apiKeyEnv;
    if (typeof refName !== "string") return undefined;
    const refs = await this.#readRefs();
    return refs[refName];
  }

  /**
   * 拉取上游 `/models` 列表。
   *
   * @param {string} baseURL
   * @param {string} apiKey
   * @returns {Promise<string[]>}
   */
  async listModels(baseURL, apiKey) {
    assertBaseURL(baseURL);
    const url = joinUrl(baseURL, "models");
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`连不上 ${url}：${err.message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`上游返回 ${res.status}：${text.slice(0, 300)}`);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`上游返回的不是 JSON：${text.slice(0, 200)}`);
    }
    // 兼容 OpenAI 的 {data:[{id}]} 和少数返回裸数组的实现
    const list = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(list)) {
      throw new Error("上游响应里没有 models 列表（期望 {data:[...]} 或 [...]）");
    }
    return list
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  /**
   * 写入 provider、Key 和默认模型，然后验证。
   *
   * @param {object} opts
   * @param {string} opts.baseURL
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @returns {Promise<void>}
   */
  async save({ baseURL, apiKey, model }) {
    assertBaseURL(baseURL);
    assertModel(model);

    const refName = "DSH_GW_API_KEY";
    const patch = await this.#readPatch();

    // ---- provider ----
    const providerEntry = {
      id: ID_PROVIDER,
      name: NAME_PROVIDER,
      config: {
        providers: {
          [PROVIDER_ID]: {
            displayName: "自定义",
            apiKeyEnv: refName,
            api: "openai-completions",
            baseURL: baseURL.replace(/\/+$/, ""),
            models: [{ id: model, name: model }],
          },
        },
      },
    };

    // ---- 默认模型 ----
    const defaultEntry = {
      id: ID_DEFAULT_MODEL,
      name: NAME_DEFAULT_MODEL,
      config: { provider: PROVIDER_ID, model },
    };

    upsert(patch, providerEntry);
    upsert(patch, defaultEntry);

    await this.#writePatch(patch);
    await this.#writeRef(refName, apiKey);
  }

  // ---------- 内部 ----------

  /** @returns {Promise<object[]>} */
  async #readPatch() {
    let raw;
    try {
      raw = await readFile(this.patchPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    return parsePatchList(raw);
  }

  /** @param {object[]} entries */
  async #writePatch(entries) {
    await mkdir(dirname(this.patchPath), { recursive: true });
    const text = [
      "# 由 dsh-auth-gateway 写入：模型配置。",
      "# 这个文件 DSH 会热加载，改完不用重启。",
      ...entries.map((e) => renderEntry(e)),
    ].join("\n");
    await writeAtomic(this.patchPath, `${text}\n`);
  }

  /** @returns {Promise<Record<string, string>>} */
  async #readRefs() {
    let raw;
    try {
      raw = await readFile(this.credentialsPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
    return parseRefs(raw);
  }

  /**
   * 把 Key 写进 credentials 的 refs 段。
   *
   * 保留文件里其它内容（尤其是 records 里的 browser-session 签名密钥，
   * 它一care 丢用户就掉线）。所以这里按行改写，不做 YAML 重建。
   *
   * @param {string} refName
   * @param {string} value
   */
  async #writeRef(refName, value) {
    let raw = "";
    try {
      raw = await readFile(this.credentialsPath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await mkdir(dirname(this.credentialsPath), { recursive: true });
    await writeAtomic(this.credentialsPath, upsertRefLine(raw, refName, value), 0o600);
  }
}

/**
 * patch 列表里同一个 id 只应出现一次：存在则替换，不存在则追加。
 *
 * @param {object[]} entries
 * @param {object} entry
 */
function upsert(entries, entry) {
  const at = entries.findIndex((e) => e.id === entry.id);
  if (at === -1) entries.push(entry);
  else entries[at] = entry;
}

/**
 * 解析 patch 文件为 entry 数组。
 *
 * 手写解析而不上 YAML 库，是因为 patch 里可能有 `!!js` 自定义标签和
 * 表达式，通用库要么拒绝要么求值——两种都不是我们要的。这里只做一件事：
 * 把结构读出来，用于取出/替换我们关心的那几个 entry，其余 entry 原样
 * 保留在内存里再序列化回去。
 *
 * 支持的写法覆盖 DSH 生成的文件形态：块式 mapping、块式 sequence、
 * 流式 {} / []、引号字符串、`!!js` 值（按字符串保留）。
 *
 * @param {string} raw
 * @returns {object[]}
 */
function parsePatchList(raw) {
  /** @type {{indent:number, text:string}[]} */
  const lines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const expanded = rawLine.replace(/\t/g, "  ");
    const text = expanded.trim();
    if (text === "" || text.startsWith("#")) continue;
    lines.push({ indent: expanded.length - expanded.trimStart().length, text });
  }
  if (lines.length === 0) return [];

  const { value } = parseNode(lines, 0, lines[0].indent);
  return Array.isArray(value) ? value : [];
}

/**
 * 从 pos 开始解析一个节点（mapping 或 sequence），返回值和新的位置。
 *
 * @param {{indent:number, text:string}[]} lines
 * @param {number} pos
 * @param {number} indent - 该节点的基准缩进
 * @returns {{value: unknown, pos: number}}
 */
function parseNode(lines, pos, indent) {
  if (pos >= lines.length) return { value: null, pos };
  // 以 "- " 开头 → sequence
  if (lines[pos].text.startsWith("- ") || lines[pos].text === "-") {
    return parseSequence(lines, pos, indent);
  }
  return parseMapping(lines, pos, indent);
}

/**
 * @param {{indent:number, text:string}[]} lines
 * @param {number} pos
 * @param {number} indent
 * @returns {{value: unknown, pos: number}}
 */
function parseSequence(lines, pos, indent) {
  const out = [];
  let i = pos;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;

    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (rest === "") {
      // `-` 后换行：子节点在更深缩进
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseNode(lines, i, lines[i].indent);
        out.push(sub.value);
        i = sub.pos;
      } else {
        out.push(null);
      }
      continue;
    }

    const kv = splitKeyValue(rest);
    if (kv === undefined) {
      // 纯标量项
      out.push(parseScalar(rest));
      i += 1;
      continue;
    }

    // `- key: value` 起头，说明这是一个 mapping 项；
    // 后续同层级的 key 缩进是 indent + 2（"- " 的宽度）
    const item = {};
    const childIndent = indent + 2;
    assignPair(item, kv.key, kv.value, lines, () => {
      // 值换行时，子节点位置
      i += 1;
      const start = i;
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseNode(lines, i, lines[i].indent);
        item[kv.key] = sub.value;
        i = sub.pos;
      } else {
        item[kv.key] = null;
      }
      return start;
    });
    if (kv.value !== "") i += 1;

    // 同一项里剩下的兄弟 key
    while (i < lines.length && lines[i].indent === childIndent && !lines[i].text.startsWith("- ")) {
      const sib = splitKeyValue(lines[i].text);
      if (sib === undefined) break;
      if (sib.value === "") {
        i += 1;
        if (i < lines.length && lines[i].indent > childIndent) {
          const sub = parseNode(lines, i, lines[i].indent);
          item[sib.key] = sub.value;
          i = sub.pos;
        } else {
          item[sib.key] = null;
        }
      } else {
        item[sib.key] = parseScalar(sib.value);
        i += 1;
      }
    }
    out.push(item);
  }
  return { value: out, pos: i };
}

/**
 * @param {{indent:number, text:string}[]} lines
 * @param {number} pos
 * @param {number} indent
 * @returns {{value: unknown, pos: number}}
 */
function parseMapping(lines, pos, indent) {
  const out = {};
  let i = pos;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) break;
    const kv = splitKeyValue(line.text);
    if (kv === undefined) break;
    if (kv.value === "") {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseNode(lines, i, lines[i].indent);
        out[kv.key] = sub.value;
        i = sub.pos;
      } else {
        out[kv.key] = null;
      }
    } else {
      out[kv.key] = parseScalar(kv.value);
      i += 1;
    }
  }
  return { value: out, pos: i };
}

/**
 * @param {object} target
 * @param {string} key
 * @param {string} value
 * @param {unknown[]} _lines
 * @param {() => number} _advance
 */
function assignPair(target, key, value, _lines, _advance) {
  target[key] = value === "" ? null : parseScalar(value);
}

/**
 * 拆 `key: value`。注意值里可能含冒号（URL），所以只按**第一个**冒号切。
 *
 * @param {string} text
 * @returns {{key: string, value: string} | undefined}
 */
function splitKeyValue(text) {
  const m = /^("([^"]*)"|'([^']*)'|[\w.@$/-]+)\s*:(.*)$/.exec(text);
  if (m === null) return undefined;
  const key = m[2] ?? m[3] ?? m[1];
  return { key, value: m[4].trim() };
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseScalar(text) {
  const s = text.trim();
  if (s === "") return null;
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner).map(parseScalar);
  }
  if (s.startsWith("{")) return parseFlowMap(s);
  // !!js / !!str 等标签：值整体当字符串保留
  const tagged = /^!!\w+\s+(.*)$/.exec(s);
  if (tagged !== null) return parseScalar(tagged[1]);
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  return s;
}

/** 解析流式 map（可能跨行）。 */
function parseFlowMap(text) {
  const out = {};
  const body = text.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (body === "") return out;
  for (const part of splitTopLevel(body)) {
    const kv = splitKeyValue(part);
    if (kv !== undefined) out[kv.key] = parseScalar(kv.value);
  }
  return out;
}

/** 按顶层逗号切分（忽略引号/括号内的逗号）。 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * 从 patch 列表里找我们的 provider entry。
 * @param {object[]} entries
 */
function findProvider(entries) {
  return entries.find((e) => e.id === ID_PROVIDER);
}

/**
 * 序列化一个 patch entry。
 *
 * @param {object} entry
 * @returns {string}
 */
function renderEntry(entry) {
  // 注意 name 必须走 scalar()：包名以 @ 开头，YAML 里 @ 是保留字符，
  // 裸写会直接解析失败（bad indentation）。
  const lines = [`- id: ${scalar(entry.id)}`, `  name: ${scalar(entry.name)}`];
  if (entry.config !== undefined) {
    lines.push("  config:");
    renderValue(entry.config, 4, lines);
  }
  return lines.join("\n");
}

/**
 * @param {unknown} value
 * @param {number} indent
 * @param {string[]} out
 */
function renderValue(value, indent, out) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const sub = [];
        renderValue(item, indent + 2, sub);
        const [first, ...rest] = sub;
        out.push(`${pad}- ${first.trimStart()}`);
        out.push(...rest);
      } else {
        out.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v) && v.length === 0) {
        out.push(`${pad}${k}: []`);
        continue;
      }
      out.push(`${pad}${k}:`);
      renderValue(v, indent + 2, out);
    } else {
      out.push(`${pad}${k}: ${scalar(v)}`);
    }
  }
}

/** @param {unknown} v */
function scalar(v) {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  // 引号策略：只有在 YAML 会误解时才加。
  // URL、路径、模型 id 这类都能裸写，和 DSH 自己生成的风格一致。
  if (s === "") return '""';
  const needsQuote =
    // 会被当成布尔/null/数字
    /^(true|false|null|~|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/.test(s) ||
    // 开头是 YAML 保留指示符（@ 和 ` 是保留字符，裸写直接报错）
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    // 含冒号+空格、井号、换行（冒号后无空格是合法的，URL 就是）
    /:\s/.test(s) ||
    /#/.test(s) ||
    /[\n\r\t]/.test(s) ||
    // 首尾空格
    /^\s|\s$/.test(s);
  if (!needsQuote) return s;
  // 双引号里反斜杠要转义
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 在 credentials 文件里设置/更新一个 ref，保留其余内容。
 *
 * @param {string} raw - 原文件文本（可能为空）
 * @param {string} refName
 * @param {string} value
 * @returns {string}
 */
function upsertRefLine(raw, refName, value) {
  if (raw.trim() === "") {
    return `version: 1\nrefs:\n  ${refName}: ${value}\n`;
  }

  const lines = raw.split(/\r?\n/);
  const refsAt = lines.findIndex((l) => /^refs:\s*$/.test(l));

  if (refsAt === -1) {
    // 没有 refs 段：插在 version 之后（或文件开头）
    const versionAt = lines.findIndex((l) => /^version:/.test(l));
    const insertAt = versionAt === -1 ? 0 : versionAt + 1;
    lines.splice(insertAt, 0, `refs:\n  ${refName}: ${value}`);
    return lines.join("\n");
  }

  // 现有 refs 段有两种写法：块式（缩进行）和流式（{...}）
  const refsLine = lines[refsAt];
  const next = lines[refsAt + 1] ?? "";
  const isFlow = /\{/.test(refsLine) || next.trim().startsWith("{");

  if (isFlow) {
    // 流式：找到 {...} 的结束行，整体重写这段
    let end = refsAt;
    if (/\}/.test(refsLine)) {
      end = refsAt;
    } else {
      let i = refsAt + 1;
      while (i < lines.length && !/\}/.test(lines[i])) i += 1;
      end = i;
    }
    const current = parseRefs(lines.slice(refsAt, end + 1).join("\n"));
    current[refName] = value;
    const block = Object.entries(current)
      .map(([k, v]) => `    ${k}: ${v},`)
      .join("\n");
    lines.splice(refsAt, end - refsAt + 1, "refs:", "  {", block, "  }");
    return lines.join("\n");
  }

  // 块式：找 refs 段的范围，段内已有该 key 就替换
  let end = lines.length;
  for (let i = refsAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) {
      end = i;
      break;
    }
  }
  for (let i = refsAt + 1; i < end; i += 1) {
    const m = /^(\s+)([\w]+):\s*(.*)$/.exec(lines[i]);
    if (m !== null && m[2] === refName) {
      lines[i] = `${m[1]}${refName}: ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(refsAt + 1, 0, `  ${refName}: ${value}`);
  return lines.join("\n");
}

/**
 * 从 credentials 文件里读 refs 段。
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseRefs(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  const refsAt = lines.findIndex((l) => /^refs:\s*$/.test(l) || /^refs:\s*\{/.test(l));
  if (refsAt === -1) return out;
  for (let i = refsAt; i < lines.length; i += 1) {
    const l = lines[i];
    if (i > refsAt && l.trim() !== "" && !/^\s/.test(l)) break;
    const m = /([A-Za-z_][A-Za-z0-9_]*):\s*([^,}\s]+)/.exec(l);
    if (m !== null && m[1] !== "refs") out[m[1]] = m[2];
  }
  return out;
}

/**
 * 原子写入：先写临时文件再 rename，避免写一半掉电把配置写坏。
 * @param {string} path
 * @param {string} content
 * @param {number} [mode]
 */
async function writeAtomic(path, content, mode) {
  const tmp = `${path}.gw-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, mode === undefined ? undefined : { mode });
  await rename(tmp, path);
  if (mode !== undefined) {
    // rename 不保证保留权限位，显式再设一次
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  }
}

/**
 * @param {string} baseURL
 */
function assertBaseURL(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("API 地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API 地址必须是 http:// 或 https://");
  }
}

/**
 * @param {string} model
 */
function assertModel(model) {
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("请选择默认模型");
  }
  if (!/^[\w.:\-/]{1,200}$/.test(model)) {
    throw new Error("模型 id 含非法字符");
  }
}

/**
 * @param {string} base
 * @param {string} path
 */
function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
