/**
 * 登录会话：HMAC 签名的 cookie。
 *
 * 为什么不用随机 session id + 服务端 Map：
 *   - 重启后 Map 清空，用户被迫重新登录；签名 cookie 只需密钥持久化即可存活
 *   - 网关是单进程单用户，无需服务端撤销列表
 *
 * 密钥与凭据分开存放：轮换会话密钥不该让密码失效。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SECRET_FILE = "session-secret";
const SECRET_BYTES = 32;
const COOKIE_NAME = "dsh_gw_session";
const COOKIE_VERSION = "v1";

export class SessionManager {
  /**
   * @param {string} dataDir - 密钥存放目录
   * @param {number} maxAgeSeconds - 会话有效期（秒）
   */
  constructor(dataDir, maxAgeSeconds) {
    this.secretPath = join(dataDir, SECRET_FILE);
    this.maxAgeSeconds = maxAgeSeconds;
    this.secret = null;
  }

  /**
   * 加载或生成签名密钥。
   * @returns {Promise<void>}
   */
  async init() {
    try {
      const raw = await readFile(this.secretPath, "utf8");
      const buf = Buffer.from(raw.trim(), "base64");
      if (buf.length !== SECRET_BYTES) {
        throw new Error(
          `会话密钥文件 ${this.secretPath} 长度异常（应为 ${SECRET_BYTES} 字节），请删除后重启。`,
        );
      }
      this.secret = buf;
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const generated = randomBytes(SECRET_BYTES);
    await mkdir(dirname(this.secretPath), { recursive: true });
    await writeFile(this.secretPath, `${generated.toString("base64")}\n`, {
      mode: 0o600,
    });
    this.secret = generated;
  }

  /**
   * 签发会话 cookie。
   * @returns {string} `Set-Cookie` 的值
   */
  issue() {
    const payload = {
      v: COOKIE_VERSION,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.maxAgeSeconds,
      // 每次签发带一个随机 nonce，让「两个标签页拿到相同 cookie」不可能发生，
      // 也让日志比对时能区分不同登录
      n: randomBytes(8).toString("base64url"),
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = this.#sign(body);
    const value = `${COOKIE_VERSION}.${body}.${sig}`;

    const attrs = [
      `${COOKIE_NAME}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${this.maxAgeSeconds}`,
    ];
    return attrs.join("; ");
  }

  /**
   * 清除会话 cookie。
   * @returns {string}
   */
  clear() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /**
   * 校验请求里的会话 cookie。
   *
   * @param {import("node:http").IncomingMessage} req
   * @returns {boolean}
   */
  verify(req) {
    const raw = readCookie(req.headers.cookie, COOKIE_NAME);
    if (raw === undefined) return false;

    const parts = raw.split(".");
    if (parts.length !== 3) return false;
    const [version, body, sig] = parts;
    if (version !== COOKIE_VERSION) return false;

    // 先验签再解 payload：不验签就解析，等于让攻击者构造任意 exp
    const expected = this.#sign(body);
    const actual = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (actual.length !== expectedBuf.length) return false;
    if (!timingSafeEqual(actual, expectedBuf)) return false;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    if (typeof payload?.exp !== "number") return false;
    if (payload.exp * 1000 <= Date.now()) return false;
    return true;
  }

  /**
   * @param {string} body
   * @returns {string} base64url 签名
   */
  #sign(body) {
    if (this.secret === null) throw new Error("SessionManager 未初始化");
    return createHmac("sha256", this.secret)
      .update(body)
      .digest("base64url");
  }
}

/**
 * 从 Cookie 头里取指定名字的值。
 *
 * 自己解析而不上 cookie 库：只需要读一个已知名字，
 * 通用解析器还要处理 quoted-string、逗号分隔等分支，风险面更大。
 *
 * @param {string | undefined} header
 * @param {string} name
 * @returns {string | undefined}
 */
function readCookie(header, name) {
  if (header === undefined) return undefined;
  for (const segment of header.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

export { COOKIE_NAME };
