/**
 * 配置写入的往返测试。
 *
 * 用真实的 patch 文件做「解析 → 序列化 → 再解析」，
 * 确认结构没被破坏。最后用 dsh --dump-config 验证 DSH 能读。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshConfigWriter } from "../src/dsh-config.js";

const HOME = process.env.HOME ?? process.env.USERPROFILE;
const REAL = join(HOME, ".dsh", "profiles", "web", "cordis.patch.yml");

const temp = await mkdtemp(join(tmpdir(), "gwcfg-"));
const fakeHome = join(temp, ".dsh");
const profileDir = join(fakeHome, "profiles", "web");
await mkdir(profileDir, { recursive: true });

// 只复制本工具会碰的两个文件（profiles/node_modules 里是符号链接，
// 整体 recursion 复制会 EPERM）
const origPatch = await readFile(REAL, "utf8");
await writeFile(join(profileDir, "cordis.patch.yml"), origPatch);
const origCred = await readFile(join(HOME, ".dsh", ".credentials.yaml"), "utf8");
await writeFile(join(fakeHome, ".credentials.yaml"), origCred);

const writer = new DshConfigWriter(fakeHome, "web");

console.log("=== 1. 读取初始配置 ===");
console.log(" ", JSON.stringify(await writer.read()));

console.log("=== 2. 写入 provider + 默认模型 + Key ===");
await writer.save({
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test-1234567890",
  model: "deepseek-v4-1-flash",
});
console.log("  写入完成");

console.log("=== 3. 读回验证 ===");
const after = await writer.read();
console.log(" ", JSON.stringify(after));

console.log("=== 4. 生成的 patch 文件 ===");
const patch = await readFile(join(fakeHome, "profiles", "web", "cordis.patch.yml"), "utf8");
console.log(patch.split("\n").map((l) => `  ${l}`).join("\n"));

console.log("=== 5. 生成的 credentials（脱敏）===");
const cred = await readFile(join(fakeHome, ".credentials.yaml"), "utf8");
console.log(cred.replace(/sk-test-\w+/g, "sk-test-***"));

console.log("=== 6. 二次写入（改模型，验证幂等不重复）===");
await writer.save({
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-test-NEWKEY999",
  model: "deepseek-v4-1-pro",
});
const patch2 = await readFile(join(fakeHome, "profiles", "web", "cordis.patch.yml"), "utf8");
const idCount = (patch2.match(/- id: llm-pi-ai/g) ?? []).length;
console.log(`  llm-pi-ai 出现次数: ${idCount}（应为 1）`);
console.log(`  agent-default-model 次数: ${(patch2.match(/- id: agent-default-model/g) ?? []).length}（应为 1）`);
const cred2 = await readFile(join(fakeHome, ".credentials.yaml"), "utf8");
console.log(`  DSH_GW_API_KEY 次数: ${(cred2.match(/DSH_GW_API_KEY/g) ?? []).length}（应为 1）`);
console.log(`  Key 已更新: ${cred2.includes("NEWKEY999")}`);

await rm(temp, { recursive: true, force: true });
console.log("\n清理完成");
