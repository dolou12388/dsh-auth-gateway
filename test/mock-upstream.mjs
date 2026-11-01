/**
 * 假上游 + 网关的端到端测试。
 *
 * 起一个假的 OpenAI 兼容服务（/v1/models），让网关真的去拉，
 * 走完「拉取 → 保存 → DSH 采纳」全流程。
 *
 * 注意：服务端要能用，必须在有 DSH 的环境里跑，所以默认只测
 * listModels + save 两个纯函数，不启动 HTTP 网关。
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshConfigWriter } from "../src/dsh-config.js";

const temp = await mkdtemp(join(tmpdir(), "gwmock-"));
const fakeHome = join(temp, ".dsh");
await mkdir(join(fakeHome, "profiles", "web"), { recursive: true });
await mkdir(fakeHome, { recursive: true });

// ---- 假上游 ----
const GOOD_KEY = "sk-good";
const server = createServer((req, res) => {
  if (req.url === "/v1/models" || req.url === "/models") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek-v4-1-flash", object: "model" },
          { id: "deepseek-v4-1-pro", object: "model" },
          { id: "deepseek-chat", object: "model" },
        ],
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("nope");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}/v1`;
console.log(`假上游已启动: ${baseURL}\n`);

const writer = new DshConfigWriter(fakeHome, "web");

console.log("=== 1. 正确 Key 拉列表 ===");
const models = await writer.listModels(baseURL, GOOD_KEY);
console.log(" ", models);

console.log("=== 2. 错误 Key 拉列表（应报错）===");
try {
  await writer.listModels(baseURL, "sk-wrong");
  console.log("  ❌ 没有报错，不应该");
  process.exitCode = 1;
} catch (err) {
  console.log("  ✓ 正确报错:", err.message.slice(0, 80));
}

console.log("=== 3. 保存后读回 ===");
await writer.save({ baseURL, apiKey: GOOD_KEY, model: "deepseek-v4-1-pro" });
const state = await writer.read();
console.log(" ", JSON.stringify(state));
console.log("  Key 回读:", (await writer.readKey()) === GOOD_KEY ? "✓" : "❌");

console.log("=== 4. 用保存的 Key 再拉一次（模拟页面留空）===");
const saved = await writer.readKey();
const again = await writer.listModels(state.baseURL, saved);
console.log(`  ✓ 用已存 Key 拉到 ${again.length} 个模型`);

server.close();
await rm(temp, { recursive: true, force: true });
console.log("\n完成");
