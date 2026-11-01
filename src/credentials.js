/**
 * 密码凭据存储。
 *
 * 设计要点：
 *   - 用 scrypt 派生，参数写进记录里，将来调参不会让旧密码失效
 *   - 首次启动时没有凭据文件 → 进入「初始化模式」，由第一个访问者设置密码
 *   - 写入用原子替换（先写临时文件再 rename），避免断电写坏
 *   - 校验用 timingSafeEqual，防止按字节的时间侧信道
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** scrypt 参数。N 越大越慢，16384 在普通机器约 30-50ms，够用且不拖慢登录。 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 512;

/** 凭据文件名（放在 dataDir 下）。 */
const CREDENTIAL_FILE = "credential.json";

/**
 * @typedef {object} CredentialRecord
 * @property {number} version - 记录格式版本
 * @property {string} salt - base64
 * @property {string} hash - base64（scrypt 派生结果）
 * @property {object} params - scrypt 参数快照
 * @property {string} createdAt - ISO 时间
 */

export class CredentialStore {
  /**
   * @param {string} dataDir - 存放凭据的目录
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, CREDENTIAL_FILE);
    /** 内存缓存：null 表示尚未加载，false 表示确认无凭据 */
    this.cached = null;
    /** 串行化写操作，避免并发初始化写出两份 */
    this.writeChain = Promise.resolve();
  }

  /**
   * 读取凭据；不存在返回 undefined。
   *
   * 解析失败按「无凭据」处理并告警，但**不删除**文件——用户可能手误改坏了，
   * 静默删掉等于把门锁拆了。让运维自己修。
   *
   * @returns {Promise<CredentialRecord | undefined>}
   */
  async load() {
    if (this.cached !== null) {
      return this.cached === false ? undefined : this.cached;
    }
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this.cached = false;
        return undefined;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `凭据文件 ${this.filePath} 不是合法 JSON。请修复或删除它后重启（删除会重新进入首次设置）。`,
      );
    }
    if (
      typeof parsed?.salt !== "string" ||
      typeof parsed?.hash !== "string" ||
      typeof parsed?.params?.N !== "number"
    ) {
      throw new Error(
        `凭据文件 ${this.filePath} 结构不完整。请修复或删除它后重启。`,
      );
    }
    this.cached = parsed;
    return parsed;
  }

  /**
   * 是否已完成初始化（已有密码）。
   * @returns {Promise<boolean>}
   */
  async isInitialized() {
    return (await this.load()) !== undefined;
  }

  /**
   * 设置初始密码。已初始化时抛错——不允许静默覆盖。
   *
   * @param {string} password - 明文密码
   * @returns {Promise<void>}
   */
  async initialize(password) {
    assertPasswordPolicy(password);
    // 关键：初始化必须二次确认「当前确实没有凭据」，
    // 否则两个并发请求会各写一份，后写的静默覆盖前一个。
    const existing = await this.load();
    if (existing !== undefined) {
      throw new Error("已存在密码，不能重复初始化");
    }
    const record = await buildRecord(password);
    await this.#persist(record);
    this.cached = record;
  }

  /**
   * 校验密码。
   *
   * @param {string} password - 用户提交的明文
   * @returns {Promise<boolean>} 是否匹配
   */
  async verify(password) {
    const record = await this.load();
    if (record === undefined) return false;
    // 长度上限先挡掉，避免拿超长输入去喂 scrypt 拖慢进程
    if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
      return false;
    }
    const { params } = record;
    const salt = Buffer.from(record.salt, "base64");
    let derived;
    try {
      derived = await scryptAsync(password, salt, params.keylen, {
        N: params.N,
        r: params.r,
        p: params.p,
        // scrypt 需要显式放宽 maxmem，否则 N=16384 时默认上限会报错
        maxmem: 256 * 1024 * 1024,
      });
    } catch {
      return false;
    }
    const expected = Buffer.from(record.hash, "base64");
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  }

  /**
   * 修改密码（需先验证旧密码）。
   *
   * @param {string} oldPassword - 旧密码
   * @param {string} newPassword - 新密码
   * @returns {Promise<boolean>} 旧密码是否正确
   */
  async change(oldPassword, newPassword) {
    assertPasswordPolicy(newPassword);
    const ok = await this.verify(oldPassword);
    if (!ok) return false;
    const record = await buildRecord(newPassword);
    await this.#persist(record);
    this.cached = record;
    return true;
  }

  /**
   * 原子写入凭据。
   * @param {CredentialRecord} record
   */
  async #persist(record) {
    const task = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      // 0600：只有属主可读写。凭据文件泄露等于密码可离线爆破。
      await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      await rename(tmp, this.filePath);
    };
    this.writeChain = this.writeChain.then(task, task);
    await this.writeChain;
  }
}

/**
 * 生成凭据记录。
 * @param {string} password
 * @returns {Promise<CredentialRecord>}
 */
async function buildRecord(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  });
  return {
    version: 1,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    params: { ...SCRYPT_PARAMS },
    createdAt: new Date().toISOString(),
  };
}

/**
 * 密码强度下限。
 *
 * 只做最低限度约束（长度），不强制大小写符号——强制复杂规则反而
 * 促使人们用 `Passw0rd!` 这类可预测密码。长度是最有效的单一因素。
 *
 * @param {string} password
 */
function assertPasswordPolicy(password) {
  if (typeof password !== "string") throw new Error("密码必须是字符串");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`密码不能超过 ${MAX_PASSWORD_LENGTH} 位`);
  }
}

export const PASSWORD_POLICY = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
