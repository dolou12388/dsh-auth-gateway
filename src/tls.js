/**
 * 自签 TLS 证书生成。
 *
 * 不依赖 openssl 命令行，也不引第三方库——用 Node 内置 crypto 手搓 X.509
 * 太容易出错，所以这里走一个折中：调用系统自带的 openssl（Linux/macOS 都有），
 * 没有就明确报错并给出替代方案。
 *
 * 为什么不做「纯 Node 生成」：手写 ASN.1/DER 编码的证书在各类浏览器上
 * 兼容性风险高，而这个网关的安全边界不允许「证书悄悄有问题」。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DAYS = 3650;

/**
 * 确保证书存在，不存在则生成。
 *
 * @param {object} opts
 * @param {string} opts.certPath
 * @param {string} opts.keyPath
 * @param {string} opts.commonName - 证书 CN，一般是公网 IP 或主机名
 * @param {(msg: string) => void} opts.log
 * @returns {Promise<{cert: Buffer, key: Buffer}>}
 */
export async function ensureCertificate({ certPath, keyPath, commonName, log }) {
  const existing = await tryRead(certPath, keyPath);
  if (existing !== undefined) return existing;

  log(`未找到证书，正在为 "${commonName}" 生成自签证书（有效期 ${DAYS} 天）…`);
  await mkdir(dirname(certPath), { recursive: true });
  await mkdir(dirname(keyPath), { recursive: true });

  // subjectAltName 必须写 IP:，否则现代浏览器不认 IP 访问的证书
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(commonName);
  const san = isIp ? `IP:${commonName}` : `DNS:${commonName}`;

  const args = [
    "req", "-x509", "-nodes",
    "-newkey", "rsa:2048",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", String(DAYS),
    "-subj", `/CN=${commonName}`,
    "-addext", `subjectAltName=${san}`,
  ];

  try {
    await execFileAsync("openssl", args, { windowsHide: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        "系统没有 openssl，无法自动生成证书。\n" +
          "  方案一：安装 openssl（Debian/Ubuntu: apt install openssl）\n" +
          "  方案二：用 --http 启动（密码会明文传输，仅限本机/可信内网）\n" +
          "  方案三：自己准备证书，用 --cert/--key 指定路径",
      );
    }
    throw new Error(`生成证书失败: ${err.stderr ?? err.message}`);
  }

  const result = await tryRead(certPath, keyPath);
  if (result === undefined) throw new Error("证书生成后读取失败");
  log(`证书已生成: ${certPath}`);
  return result;
}

/**
 * @param {string} certPath
 * @param {string} keyPath
 * @returns {Promise<{cert: Buffer, key: Buffer} | undefined>}
 */
async function tryRead(certPath, keyPath) {
  try {
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    return { cert, key };
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}
