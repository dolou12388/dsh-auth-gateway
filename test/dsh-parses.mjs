/**
 * 让 DSH 自己去解析我们写出的配置。
 *
 * 这是最关键的一步验证：往返测试只能证明「我自己读得懂」，
 * 只有 `dsh --dump-config` 通过，才证明 DSH 也认。
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DshConfigWriter } from "../src/dsh-config.js";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME ?? process.env.USERPROFILE;

const temp = await mkdtemp(join(tmpdir(), "gwv-"));
const fakeHome = join(temp, ".dsh");
const srcProf = join(HOME, ".dsh", "profiles", "web");
const dstProf = join(fakeHome, "profiles", "web");

await (await import("node:fs/promises")).mkdir(dstProf, { recursive: true });
for (const f of ["package.json", "cordis.yml"]) {
  await copyFile(join(srcProf, f), join(dstProf, f));
}

const writer = new DshConfigWriter(fakeHome, "web");
await writer.save({
  baseURL: "https://api.dsestest.com/v1",
  apiKey: "sk-verify-abc",
  model: "deepseek-v4-1-flash",
});

console.log("=== DSH 解析我们写出的配置 ===");
try {
  const { stdout } = await execFileAsync(
    "dsh",
    ["--profile", "web", "--dump-config"],
    {
      env: { ...process.env, DSH_HOME: fakeHome },
      timeout: 120_000,
      // Windows 上 dsh 是 .cmd/.ps1，必须走 shell 才能解析
      shell: process.platform === "win32",
    },
  );
  // 只摘出与我们相关的节点
  const lines = stdout.split("\n");
  const hits = lines.filter((l) =>
    /llm-pi-ai|agent-default-model|custom|dsestest|DSH_GW_API_KEY/.test(l),
  );
  console.log(hits.map((l) => `  ${l}`).join("\n") || "  （没找到我们写入的节点）");
  const ok =
    stdout.includes("dsestest.com") && stdout.includes("DSH_GW_API_KEY");
  console.log(ok ? "\n✅ DSH 成功解析并采纳了我们写入的配置" : "\n⚠️ DSH 解析成功，但没看到我们的配置");
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.log("❌ DSH 解析失败");
  console.log("stderr:", (err.stderr ?? "").slice(0, 1500));
  console.log("stdout:", (err.stdout ?? "").slice(0, 800));
  process.exitCode = 1;
}

await rm(temp, { recursive: true, force: true });
