#!/usr/bin/env node
/**
 * dsh-auth-gateway
 *
 * 给 DSH Web 套一层「首次访问自设密码」的认证网关。
 *
 * 架构：
 *
 *     浏览器 ──HTTPS(自签)──> 网关(本进程) ──HTTP(回环)──> DSH :3299
 *                              │
 *                              ├─ 无 cookie → 登录页 / 首次设置页
 *                              └─ 有 cookie → 原样转发（含 WebSocket）
 *
 * 关键约束（都是实测踩出来的）：
 *   - Host 头必须原样透传，否则 DSH 的 cookie 校验和 rebinding 围栏都会失败
 *   - WebSocket 的 /api/remote.mux 必须转发，否则「页面能开不能聊」
 *   - DSH 侧 trustedHosts 要填**用户浏览器看到的** authority
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

import { CredentialStore, PASSWORD_POLICY } from "./credentials.js";
import { SessionManager, COOKIE_NAME } from "./session.js";
import { DshSessionSigner, cookieName as dshCookieName } from "./dsh-session.js";
import { DshConfigWriter } from "./dsh-config.js";
import { renderLoginPage, renderMessagePage, escapeHtml } from "./login-page.js";
import { renderConfigPage } from "./config-page.js";
import { UpstreamProxy } from "./proxy.js";
import { ensureCertificate } from "./tls.js";

const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const LOGIN_PATH = "/__gateway/login";
const LOGOUT_PATH = "/__gateway/logout";
const CONFIG_PATH = "/__gateway/config";
const MODELS_PATH = "/__gateway/models";
const SAVE_CONFIG_PATH = "/__gateway/save-config";
const MAX_BODY_BYTES = 8192;

/** @type {ReturnType<typeof parseArgs>} */
let parsed;
try {
  parsed = parseArgs({
    options: {
      port: { type: "string", default: "8443" },
      host: { type: "string", default: "0.0.0.0" },
      upstream: { type: "string", default: "http://127.0.0.1:3299" },
      "data-dir": { type: "string" },
      http: { type: "boolean", default: false },
      cert: { type: "string" },
      key: { type: "string" },
      "public-host": { type: "string" },
      "trust-proxy": { type: "boolean", default: false },
      "dsh-home": { type: "string" },
      profile: { type: "string", default: "web" },
      "no-sso": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (err) {
  console.error(`参数错误: ${err.message}`);
  process.exit(2);
}

const opts = parsed.values;

if (opts.help) {
  console.log(`dsh-auth-gateway — 为 DSH Web 提供首次登录设置密码的认证网关

用法:
  dsh-auth-gateway [options]

选项:
  --port <n>          监听端口（默认 8443）
  --host <addr>       监听地址（默认 0.0.0.0）
  --upstream <url>    DSH 地址（默认 http://127.0.0.1:3299）
  --data-dir <path>   凭据与会话密钥存放目录
                      （默认 $DSH_GATEWAY_HOME 或 ~/.dsh-auth-gateway）
  --http              用明文 HTTP 启动（不生成证书；密码会明文传输）
  --cert <path>       自定义证书路径（默认 <data-dir>/cert.pem）
  --key <path>        自定义私钥路径（默认 <data-dir>/key.pem）
  --public-host <h>   证书 CN / 浏览器访问的地址（默认自动探测本机 IP）
  --trust-proxy       信任 X-Forwarded-For（前面还有一层代理时才开）
  --dsh-home <path>   DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
                      网关从中读取 cookie 签名密钥，登录后自动签一张
                      DSH 认的 cookie，免去在 DSH 页面二次登录
  --profile <name>    要配置的 DSH profile（默认 web）
  --no-sso            关闭上面的自动签发（DSH 会要求再输一次 token）
  -h, --help          显示帮助

首次使用:
  启动后浏览器打开 https://<你的IP>:8443
  自签证书会警告，选择「继续访问」即可。
  然后页面会要求你设置访问密码——这个密码只有你自己知道，
  网关用它派生 scrypt 哈希存在本地。

示例:
  dsh-auth-gateway --port 8443 --upstream http://127.0.0.1:3299
`);
  process.exit(0);
}

const port = Number(opts.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`--port 必须是 1-65535 的整数，收到 ${JSON.stringify(opts.port)}`);
  process.exit(2);
}

const upstreamUrl = parseUpstream(opts.upstream);
const dataDir =
  opts["data-dir"] ?? process.env.DSH_GATEWAY_HOME ?? join(homedir(), ".dsh-auth-gateway");
const dshHome = opts["dsh-home"] ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");

/** @param {string} msg @param {object} [meta] */
function log(msg, meta) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const extra = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  console.log(`[${stamp}] ${msg}${extra}`);
}

/**
 * @param {string} input
 * @returns {URL}
 */
function parseUpstream(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    console.error(`--upstream 不是合法 URL: ${input}`);
    process.exit(2);
  }
  if (url.protocol !== "http:") {
    console.error(
      `--upstream 只支持 http://（网关与 DSH 同机，无需 https）。收到 ${url.protocol}`,
    );
    process.exit(2);
  }
  return url;
}

const credentials = new CredentialStore(dataDir);
const sessions = new SessionManager(dataDir, SESSION_MAX_AGE);
const proxy = new UpstreamProxy({ upstream: upstreamUrl, log });
/**
 * DSH 会话 cookie 签发器。关掉 SSO 时不启用。
 *
 * 用途：用户在这里输一次密码，直接把 DSH 的会话 cookie 一并下发，
 * 否则 DSH 会再拦一道「authentication required」。
 */
const dshSigner = opts["no-sso"] ? undefined : new DshSessionSigner(dshHome, SESSION_MAX_AGE);
/** 模型配置读写。 */
const configWriter = new DshConfigWriter(dshHome, opts.profile ?? "web");

/** 简单的失败计数，防在线爆破。键是客户端 IP。 */
const failures = new Map();
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 记一次失败；超过阈值后在窗口内直接拒绝。
 * @param {string} ip
 * @returns {boolean} true 表示已被限流
 */
function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip) ?? { count: 0, first: now };
  if (now - entry.first > FAILURE_WINDOW_MS) {
    entry.count = 0;
    entry.first = now;
  }
  entry.count += 1;
  failures.set(ip, entry);
  return entry.count >= MAX_FAILURES;
}

/** @param {string} ip */
function clearFailures(ip) {
  failures.delete(ip);
}

/** @param {string} ip @returns {boolean} */
function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (entry === undefined) return false;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

/**
 * 取客户端 IP（用于限流）。
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
function clientIp(req) {
  if (opts["trust-proxy"]) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * 读取并限制请求体大小。
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<URLSearchParams>}
 */
async function readFormBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 请求处理器：先认证，通过后转发。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;
  const ip = clientIp(req);

  // ---- 登出 ----
  if (path === LOGOUT_PATH) {
    res.writeHead(303, {
      "set-cookie": sessions.clear(),
      location: "/",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  // ---- 登录 / 首次设置提交 ----
  if (path === LOGIN_PATH) {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end("method not allowed");
      return;
    }
    if (isLockedOut(ip)) {
      log(`登录被限流 ip=${ip}`);
      res.writeHead(429, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        renderMessagePage({
          title: "尝试次数过多",
          message: "请在 15 分钟后再试。",
        }),
      );
      return;
    }

    let form;
    try {
      form = await readFormBody(req);
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(renderMessagePage({ title: "请求无效", message: String(err.message) }));
      return;
    }

    const password = form.get("password") ?? "";
    const next = safeNext(form.get("next"));
    const initialized = await credentials.isInitialized();

    if (!initialized) {
      const confirm = form.get("confirm") ?? "";
      if (password !== confirm) {
        await sendLoginPage(res, {
          setupMode: true,
          error: "两次输入的密码不一致",
          next,
          status: 400,
        });
        return;
      }
      try {
        await credentials.initialize(password);
      } catch (err) {
        // 竞态：两个请求同时初始化时，后到的会在这里收到「已存在密码」
        if (String(err.message).includes("已存在密码")) {
          await sendLoginPage(res, {
            setupMode: false,
            error: "密码已被设置，请直接登录",
            next,
            status: 409,
          });
          return;
        }
        await sendLoginPage(res, {
          setupMode: true,
          error: err.message,
          next,
          status: 400,
        });
        return;
      }
      log(`首次设置密码完成 ip=${ip}`);
      res.writeHead(303, {
        "set-cookie": await buildCookies(req),
        location: next,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const ok = await credentials.verify(password);
    if (!ok) {
      const locked = recordFailure(ip);
      log(`登录失败 ip=${ip} 累计=${failures.get(ip)?.count ?? 0}${locked ? "（已限流）" : ""}`);
      await sendLoginPage(res, {
        setupMode: false,
        error: locked ? "尝试次数过多，请稍后再试" : "密码不正确",
        next,
        status: locked ? 429 : 401,
      });
      return;
    }

    clearFailures(ip);
    log(`登录成功 ip=${ip}`);
    res.writeHead(303, {
      "set-cookie": await buildCookies(req),
      location: next,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  // ---- 模型配置页 ----
  if (path === CONFIG_PATH) {
    if (!sessions.verify(req)) {
      await sendLoginPage(res, {
        setupMode: !(await credentials.isInitialized()),
        next: CONFIG_PATH,
        status: 401,
      });
      return;
    }
    const cur = await configWriter.read().catch(() => ({ hasKey: false }));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    res.end(
      renderConfigPage({
        baseURL: cur.baseURL,
        model: cur.model,
        hasKey: cur.hasKey,
        notice: typeof url.searchParams.get("notice") === "string" ? url.searchParams.get("notice") : undefined,
        noticeIsError: url.searchParams.get("err") === "1",
      }),
    );
    return;
  }

  // ---- 拉取模型列表 ----
  if (path === MODELS_PATH) {
    if (!sessions.verify(req)) return sendJson(res, 401, { error: "未登录" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "只支持 POST" });
    const parsedBody = await readJsonBody(req).catch((err) => ({ __error: err.message }));
    if (parsedBody.__error !== undefined) return sendJson(res, 400, { error: parsedBody.__error });

    const baseURL = String(parsedBody.baseURL ?? "").trim();
    let apiKey = String(parsedBody.apiKey ?? "");
    if (apiKey === "") {
      // 页面允许留空表示「沿用已保存的 Key」
      apiKey = await readSavedKey(configWriter).catch(() => "");
      if (apiKey === "") return sendJson(res, 400, { error: "请填 API Key" });
    }
    try {
      const models = await configWriter.listModels(baseURL, apiKey);
      log(`拉取模型列表成功 数量=${models.length}`);
      return sendJson(res, 200, { models });
    } catch (err) {
      log(`拉取模型列表失败: ${err.message}`);
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- 保存配置 ----
  if (path === SAVE_CONFIG_PATH) {
    if (!sessions.verify(req)) return sendJson(res, 401, { error: "未登录" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "只支持 POST" });
    const parsedBody = await readJsonBody(req).catch((err) => ({ __error: err.message }));
    if (parsedBody.__error !== undefined) return sendJson(res, 400, { error: parsedBody.__error });

    const baseURL = String(parsedBody.baseURL ?? "").trim();
    let apiKey = String(parsedBody.apiKey ?? "");
    const model = String(parsedBody.model ?? "").trim();
    if (apiKey === "") {
      apiKey = await readSavedKey(configWriter).catch(() => "");
      if (apiKey === "") return sendJson(res, 400, { error: "请填 API Key" });
    }
    try {
      await configWriter.save({ baseURL, apiKey, model });
      log(`模型配置已保存 baseURL=${baseURL} model=${model}`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      log(`保存模型配置失败: ${err.message}`);
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- 已登录则放行 ----
  if (sessions.verify(req)) {
    // 首次进来且还没配模型 → 引导到配置页，否则用户进去只会看到一个不能对话的空壳
    if (path === "/" && !(await hasUsableModel())) {
      res.writeHead(303, { location: CONFIG_PATH, "cache-control": "no-store" });
      res.end();
      return;
    }
    // 顺手补一张 DSH 的 cookie：用户可能清过浏览器数据，或网关刚重启过。
    // 只给页面请求补，静态资源不必每次都刷 Set-Cookie。
    const extra = path === "/" ? await maybeDshCookie(req) : undefined;
    proxy.forward(req, res, extra === undefined ? undefined : { setCookie: extra });
    return;
  }

  // ---- 未登录：返回登录页（或首次设置页）----
  const initialized = await credentials.isInitialized();
  // 只接受站内相对路径，避免登录后被跳去外站
  const next = safeNext(`${path}${url.search}`);
  await sendLoginPage(res, {
    setupMode: !initialized,
    next,
    status: 401,
  });
}

/**
 * 登录成功时下发的 cookie 集合。
 *
 * 两张：网关自己的会话 + DSH 的会话。后者让用户不必在 DSH 页面再登一次。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string[]>}
 */
async function buildCookies(req) {
  const cookies = [sessions.issue()];
  const dsh = await maybeDshCookie(req);
  if (dsh !== undefined) cookies.push(dsh);
  return cookies;
}

/**
 * 需要时补签 DSH 会话 cookie。
 *
 * 判断「需不需要」：请求里已经带了有效的 DSH cookie 就别重复下发，
 * 免得每个请求都刷一遍 Set-Cookie。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string | undefined>}
 */
async function maybeDshCookie(req) {
  if (dshSigner === undefined) return undefined;
  const authority = req.headers.host;
  if (authority === undefined) return undefined;
  // 已经带了 DSH cookie 就跳过（值不校验，DSH 自己会验签；
  // 我们只避免每个请求都重发）
  if (hasCookie(req.headers.cookie, dshCookieName(authority))) return undefined;
  return dshSigner.issueFor(authority);
}

/**
 * @param {string | undefined} header
 * @param {string} name
 * @returns {boolean}
 */
function hasCookie(header, name) {
  if (header === undefined) return false;
  for (const segment of header.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return true;
  }
  return false;
}

/**
 * DSH 当前是否已经有可用的模型配置。
 *
 * 判断标准：provider 地址和 Key 都在，且有默认模型。三者缺一，
 * 进去也聊不了，不如先把人引到配置页。
 *
 * @returns {Promise<boolean>}
 */
async function hasUsableModel() {
  try {
    const cur = await configWriter.read();
    return (
      typeof cur.baseURL === "string" &&
      cur.baseURL !== "" &&
      cur.hasKey &&
      typeof cur.model === "string" &&
      cur.model !== ""
    );
  } catch {
    // 读不出来就别拦，让用户自己点进配置页
    return true;
  }
}

/**
 * 输出 JSON 响应。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 读取 JSON 请求体（同样限长）。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("请求体必须是对象");
  return parsed;
}

/**
 * 取已保存的 API Key（用于「留空表示不修改」）。
 *
 * @param {DshConfigWriter} writer
 * @returns {Promise<string>}
 */
async function readSavedKey(writer) {
  return (await writer.readKey()) ?? "";
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {object} args
 * @param {boolean} args.setupMode
 * @param {string} [args.error]
 * @param {string} args.next
 * @param {number} args.status
 */
async function sendLoginPage(res, { setupMode, error, next, status }) {
  const html = renderLoginPage({
    setupMode,
    error,
    next,
    minLength: PASSWORD_POLICY.MIN_PASSWORD_LENGTH,
  });
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}

/**
 * 只允许站内路径，防止开放重定向。
 * @param {string | null | undefined} raw
 * @returns {string}
 */
function safeNext(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  // 必须以单个 / 开头，且不能是 //host 或 /\host 这类协议相对 URL
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

async function main() {
  await sessions.init();
  const initialized = await credentials.isInitialized();

  let server;
  let scheme = "http";

  if (opts.http) {
    server = createHttpServer((req, res) => {
      handleRequest(req, res).catch((err) => fail(res, err));
    });
    log("警告：以明文 HTTP 运行，密码会以明文经过网络");
  } else {
    const certPath = opts.cert ?? join(dataDir, "cert.pem");
    const keyPath = opts.key ?? join(dataDir, "key.pem");
    const publicHost = opts["public-host"] ?? detectPublicHost();
    const { cert, key } = await ensureCertificate({
      certPath,
      keyPath,
      commonName: publicHost,
      log,
    });
    server = createHttpsServer({ cert, key }, (req, res) => {
      handleRequest(req, res).catch((err) => fail(res, err));
    });
    scheme = "https";
    log(`证书 CN=${publicHost}`);
  }

  // WebSocket：认证通过才转发，否则直接关掉
  server.on("upgrade", (req, socket, head) => {
    if (!sessions.verify(req)) {
      log(`websocket 未认证被拒 ${req.url}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    proxy.forwardUpgrade(req, socket, head);
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(port, opts.host, () => {
    const shown = opts["public-host"] ?? detectPublicHost();
    log(`网关已启动 ${scheme}://${shown}:${port}  →  ${upstreamUrl.origin}`);
    log(
      initialized
        ? "已设置密码，打开上面的地址登录即可"
        : "尚未设置密码 —— 第一个打开上面地址的人将设置密码",
    );
    if (!opts.http) {
      log("自签证书，浏览器会警告，选择「继续访问」即可");
    }
    if (dshSigner === undefined) {
      log("SSO 已关闭（--no-sso）：登录后 DSH 会要求再输一次它自己的 token");
    } else {
      dshSigner
        .ready()
        .then((ok) => {
          log(
            ok
              ? `SSO 已就绪：登录后自动签发 DSH 会话（密钥来自 ${dshHome}）`
              : `SSO 未生效：读不到 ${dshHome}/.credentials.yaml，DSH 会要求二次登录`,
          );
        })
        .catch(() => log("SSO 状态检查失败，不影响基础功能"));
    }
  });

  const shutdown = (signal) => {
    log(`收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    // 兜底：10 秒内没关完就强退，避免 systemd 一直等
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * 错误兜底：不要让异常把进程带崩，也不要给用户看堆栈。
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} err
 */
function fail(res, err) {
  log(`请求处理异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  if (!res.headersSent) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
  }
  res.end("网关内部错误");
}

/**
 * 猜一个用于证书 CN 的地址：优先第一个非内网回环 IPv4。
 * @returns {string}
 */
function detectPublicHost() {
  // 延迟 require 避免顶层 import 增加启动开销
  const { networkInterfaces } = require("node:os");
  const candidates = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      candidates.push(iface.address);
    }
  }
  // 公网 IP 优先（排除 10./172.16-31./192.168./169.254.）
  const isPrivate = (ip) =>
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const pub = candidates.find((ip) => !isPrivate(ip));
  return pub ?? candidates[0] ?? "localhost";
}

main().catch((err) => {
  console.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

export { escapeHtml, COOKIE_NAME };
