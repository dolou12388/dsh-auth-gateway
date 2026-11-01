/**
 * 终极验证：模拟真实 DSH 服务，确认「配好就能聊」。
 *
 * 起一个假 LLM 上游 + 真实 DSH（web profile，指向假上游），
 * 然后用 DSH 的 headless 模式发一句话，看能不能拿到回复。
 *
 * 跑不通就说明配置虽然写对了，但链路是断的。
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshConfigWriter } from "../src/dsh-config.js";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME ?? process.env.USERPROFILE;

// ---- 假 LLM 上游：实现 /v1/models 和 /v1/chat/completions ----
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      // 最小可用的 OpenAI 兼容流式响应
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "配置成功" }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}/v1`;
console.log(`假 LLM 上游: ${baseURL}\n`);

// ---- 准备临时 DSH home ----
// 用 headless profile 做验证：它是「跑一句话就退出」的形态，
// 最适合确认「配置写对了没有」。
const temp = await mkdtemp(join(tmpdir(), "gwlive-"));
const fakeHome = join(temp, ".dsh");
const profName = "headless";
const profDir = join(fakeHome, "profiles", profName);
await mkdir(profDir, { recursive: true });
// headless profile 用自己的 bundle 组合（dsh-base + dsh-headless），
// 不能照抄 web 的 package.json，否则 --profile headless 拿不到对应命令。
await writeFile(
  join(profDir, "package.json"),
  JSON.stringify(
    {
      name: "dsh-profile-headless",
      private: true,
      dependencies: {},
      dsh: {
        profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
      },
    },
    null,
    2,
  ),
);
await writeFile(join(profDir, "cordis.yml"), "[]\n");
// 用一份空白凭据，避免混入本机 Key
await writeFile(join(fakeHome, ".credentials.yaml"), "version: 1\nrefs:\n  {}\nrecords:\n");

console.log("=== 1. 用网关的写入器配置模型 ===");
const writer = new DshConfigWriter(fakeHome, profName);
await writer.save({ baseURL, apiKey: "sk-mock", model: "mock-model" });
console.log(" ", JSON.stringify(await writer.read()));

console.log("=== 2. DSH headless 发一句话 ===");
try {
  const { stdout, stderr } = await execFileAsync(
    "dsh",
    ["--profile", profName, "你好"],
    {
      env: { ...process.env, DSH_HOME: fakeHome },
      timeout: 150_000,
      shell: process.platform === "win32",
    },
  );
  const out = (stdout + stderr).trim();
  console.log("  输出:", out.slice(0, 600) || "(空)");
  if (out.includes("配置成功")) {
    console.log("\n✅ 全链路打通：网关写入的配置能让 DSH 真正发出请求并收到回复");
  } else {
    console.log("\n⚠️ DSH 跑起来了但没看到预期回复");
    process.exitCode = 1;
  }
} catch (err) {
  console.log("❌ DSH 执行失败");
  console.log((err.stdout ?? "").slice(0, 800));
  console.log((err.stderr ?? "").slice(0, 1200));
  process.exitCode = 1;
}

server.close();
await rm(temp, { recursive: true, force: true });
