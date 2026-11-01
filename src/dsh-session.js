/**
 * DSH 会话 cookie 签发器。
 *
 * 为什么需要这个：
 *   DSH Web 启动时会生成一个**每进程随机**的 launchToken，只有把它拼到
 *   URL 上才能换取 DSH 的会话 cookie。网关在另一个进程里，拿不到这个 token。
 *   如果什么都不做，用户输完网关密码后，仍然会看到 DSH 自己的
 *   「authentication required」页面 —— 登录两层，体验很差。
 *
 * 好在 DSH 的 cookie 签名密钥是**持久化**的（写在 ~/.dsh/.credentials.yaml
 * 的 client-connection/browser-session 记录里），而 cookie 格式是公开的：
 *
 *     dsh-auth-<base64url(sha256(authority))> = v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>
 *     payload = { version: 1, authority, issuedAt, expiresAt }   // 毫秒时间戳
 *
 * 于是网关可以自己签一个 DSH 认的 cookie —— 用户在网关输一次密码，
 * 后面整条链路都是通的，DSH 那边不会再拦。
 *
 * 注意：这不是绕过安全边界，而是把「谁能进」的决策集中到网关一层。
 * DSH 的 Host/Origin/CSRF 围栏全部照旧生效（那些检查和 cookie 是两回事）。
 */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** DSH 凭据文件里，浏览器会话签名密钥的记录键。 */
const RECORD_KEY = "client-connection/browser-session";
const COOKIE_VERSION = "v1";
const PAYLOAD_VERSION = 1;

export class DshSessionSigner {
  /**
   * @param {string} dshHome - DSH 主目录（含 .credentials.yaml）
   * @param {number} maxAgeSeconds - 签出的 cookie 有效期
   */
  constructor(dshHome, maxAgeSeconds) {
    this.credentialsPath = join(dshHome, ".credentials.yaml");
    this.maxAgeSeconds = maxAgeSeconds;
    /** @type {string | null} */
    this.secret = null;
    /** 记录上次读取文件的时间，避免每个请求都读盘 */
    this.loadedAt = 0;
  }

  /**
   * 读取 DSH 的 cookie 签名密钥。文件变化时自动重读。
   *
   * 密钥可能因为用户清空 ~/.dsh 而变，所以带一个短缓存 + 失败回退，
   * 而不是启动时读一次就固定下来。
   *
   * @returns {Promise<string | undefined>} base64url 编码的密钥；读不到返回 undefined
   */
  async #loadSecret() {
    const now = Date.now();
    if (this.secret !== null && now - this.loadedAt < 60_000) return this.secret;

    let raw;
    try {
      raw = await readFile(this.credentialsPath, "utf8");
    } catch {
      this.secret = null;
      return undefined;
    }

    const secret = extractBrowserSessionSecret(raw);
    this.secret = secret ?? null;
    this.loadedAt = now;
    return secret;
  }

  /**
   * DSH 会不会认这个 authority？认的话返回 cookie 头，否则 undefined。
   *
   * @param {string} authority - 浏览器看到的 host:port
   * @returns {Promise<string | undefined>} `Set-Cookie` 值
   */
  async issueFor(authority) {
    const secret = await this.#loadSecret();
    if (secret === undefined) return undefined;

    const now = Date.now();
    const payload = {
      version: PAYLOAD_VERSION,
      authority,
      issuedAt: now,
      expiresAt: now + this.maxAgeSeconds * 1000,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    // 关键：密钥是 base64url 字符串，HMAC 的 key 必须是它解码后的 32 字节。
    // 直接拿字符串当 key 会签出一个 DSH 不认的 cookie（表现为 401）。
    const key = Buffer.from(secret, "base64url");
    const sig = createHmac("sha256", key).update(body).digest("base64url");

    const name = cookieName(authority);
    return `${name}=${COOKIE_VERSION}.${body}.${sig}; Max-Age=${this.maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /** 是否已成功读到密钥（用于启动日志）。 */
  async ready() {
    return (await this.#loadSecret()) !== undefined;
  }
}

/**
 * 从 YAML 文本里抠出 browser-session 的 secret。
 *
 * 不上 YAML 解析器：DSH 的凭据文件结构固定，而我们只读一个已知字段。
 * 引第三方 YAML 库会为了一个字段拖进完整解析器和它的安全面。
 *
 * @param {string} raw
 * @returns {string | undefined}
 */
function extractBrowserSessionSecret(raw) {
  const lines = raw.split(/\r?\n/);
  let inRecord = false;
  for (const line of lines) {
    // 记录键的位置（允许缩进）
    if (line.includes(RECORD_KEY)) {
      inRecord = true;
      continue;
    }
    if (!inRecord) continue;
    // 走出这条记录：遇到同级或更浅的键
    const trimmed = line.trim();
    if (trimmed.startsWith("records:") || /^[a-z][\w-]*\/[\w-]+:/.test(trimmed)) {
      inRecord = false;
      continue;
    }
    const m = /^\s*secret:\s*(\S+)\s*$/.exec(line);
    if (m !== null) return m[1];
  }
  return undefined;
}

/**
 * DSH 的 cookie 名：`dsh-auth-<base64url(sha256(authority))>`（去 padding）。
 *
 * @param {string} authority
 * @returns {string}
 */
export function cookieName(authority) {
  const digest = createHash("sha256").update(authority).digest("base64url");
  return `dsh-auth-${digest}`;
}

export { extractBrowserSessionSecret };
