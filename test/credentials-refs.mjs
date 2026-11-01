#!/usr/bin/env node
/**
 * credentials refs 段的写入回归测试。
 *
 * 守的是一个真实事故：`upsertRefLine` 只用 /^refs:\s*$/ 找 refs 段，
 * 遇到流式写法 `refs: {}` 就会误判成「没有 refs 段」，转而在 version
 * 后面再插一个块式 refs —— 同一文件两个 refs 键。YAML 解析器遇到重复
 * 键直接抛错，dsh 起不来：
 *
 *   dsh: startup failed: 1 required plugin did not activate
 *     credentials
 *       Error: invalid document at ~/.dsh/.credentials.yaml:
 *              DUPLICATE_KEY at line 4, column 1
 *
 * 这个坑很隐蔽，因为它只在**流式**写法下触发，而块式写法一直正常 ——
 * 更麻烦的是读取侧 parseRefs 的正则本来就带 \{，所以「读」永远没问题，
 * 只有「写」会写坏。用户看到的现象是「装了插件但左侧没入口」，实际整个
 * 服务都没起来。
 *
 * 不依赖 ~/.dsh，不联网，直接测纯函数。
 *
 * 用法：node test/credentials-refs.mjs
 */

import { upsertRefLine, parseRefs } from "../src/dsh-config.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    return;
  }
  fail += 1;
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ✗ ${name} ${extra}`);
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

function group(title) {
  console.log(`\n${title}`);
}

const NL = "\n";
const REF = "DSH_GW_API_KEY";
const VAL = "gw-dfyudsh-test";

/** 数一个文本里 refs 顶层键有几个。重复 = YAML 非法。 */
function refsCount(text) {
  return (text.match(/^refs:/gm) ?? []).length;
}

/* ------------------------------------------------------------------ */

group("核心回归：流式 refs 不能被写坏");

{
  // 现场那个坏文件的成因，就是这个输入
  const input = ["version: 1", "refs: {}", "records:", "  a:", "    kind: grant", ""].join(NL);
  const out = upsertRefLine(input, REF, VAL);

  eq("空流式 refs: {} 写完后 refs 键唯一", refsCount(out), 1);
  ok("写入了目标 key", out.includes(`${REF}: ${VAL}`));
  ok("records 段保留", out.includes("records:"));
  // 原来的空映射应该被替换掉，而不是与之并存
  ok("没有残留孤立的 refs: {}", !out.includes("refs: {}"), JSON.stringify(out));
}

{
  // 流式但已有内容
  const input = ["version: 1", "refs: {OLD: v1}", "records:"].join(NL);
  const out = upsertRefLine(input, REF, VAL);
  eq("有内容的流式 refs 写完后键唯一", refsCount(out), 1);
  ok("原有 key 保留", out.includes("OLD"));
  ok("新 key 写入", out.includes(REF));
}

/* ------------------------------------------------------------------ */

group("其余分支不能被这次修改带坏");

{
  const input = ["version: 1", "refs:", "  OTHER: x", "records:"].join(NL);
  const out = upsertRefLine(input, REF, VAL);
  eq("块式无该 key：键唯一", refsCount(out), 1);
  ok("原有 key 保留", out.includes("OTHER"));
  ok("新 key 追加", out.includes(REF));
}

{
  const input = ["version: 1", "refs:", "  " + REF + ": old", "records:"].join(NL);
  const out = upsertRefLine(input, REF, VAL);
  eq("块式已有该 key：键唯一", refsCount(out), 1);
  ok("值被更新", out.includes(`${REF}: ${VAL}`), JSON.stringify(out));
  ok("旧值不残留", !out.includes(`${REF}: old`), JSON.stringify(out));
}

{
  const input = ["version: 1", "records:", "  a:", "    kind: grant"].join(NL);
  const out = upsertRefLine(input, REF, VAL);
  eq("完全没有 refs 段：新建且唯一", refsCount(out), 1);
  ok("插在 version 之后", /version: 1\nrefs:/.test(out), JSON.stringify(out));
  ok("records 保留", out.includes("records:"));
}

{
  const out = upsertRefLine("", REF, VAL);
  eq("空文件：键唯一", refsCount(out), 1);
  eq("空文件：版本戳正确", out.split(NL)[0], "version: 1");
}

/* ------------------------------------------------------------------ */

group("幂等：连续写两次不应累积");

{
  const input = ["version: 1", "refs: {}", "records:"].join(NL);
  const once = upsertRefLine(input, REF, VAL);
  const twice = upsertRefLine(once, REF, "gw-second");
  eq("二次写入后 refs 键仍唯一", refsCount(twice), 1);
  ok("值取最后一次", twice.includes("gw-second"));
  ok("旧值不残留", !twice.includes(VAL));
}

/* ------------------------------------------------------------------ */

group("写进去的必须读得出来");

{
  const input = ["version: 1", "refs: {}", "records:"].join(NL);
  const out = upsertRefLine(input, REF, VAL);
  const parsed = parseRefs(out);
  eq("回读拿到刚写的 key", parsed[REF], VAL);
}

{
  // 这是真正要命的组合：写坏了但读取仍能工作，所以问题会潜伏很久。
  // 用旧逻辑手搓一个坏文件，确认读取侧「看不出来」——这解释了为什么
  // 事故潜伏了 3 小时 45 分钟才在下次重启时爆发。
  const broken = ["version: 1", "refs:", `  ${REF}: ${VAL}`, "refs: {}", "records:"].join(NL);
  eq("坏文件里 refs 键有 2 个", refsCount(broken), 2);
  const parsed = parseRefs(broken);
  eq("但读取侧照样能读到值（所以发现不了）", parsed[REF], VAL);
}

/* ------------------------------------------------------------------ */

console.log(`\n${"-".repeat(50)}`);
if (fail === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  for (const row of failures) console.log(`  · ${row}`);
}
process.exit(fail === 0 ? 0 : 1);
