import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 架构约束测试：把「写在文档里的约定」变成 CI 保证。
 *
 * 这些约定目前都是成立的，但只靠自觉 —— 一旦有人图省事在 `core/` 里 import 一个方向模块、
 * 或在 ASR 适配器里复用 TTS 的东西，就悄悄退化成单文件大泥球。这里逐条锁死。
 *
 * 只做**路径级**判断（import 说明符），不做类型名扫描 —— 后者会被注释误伤
 * （`core/types.ts` 的注释里就写着 `Transcript` / `TTSChunk`）。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 取一个文件里所有 `from "..."` 的说明符。 */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
}

/** 文件是否（直接或经目录）指向某个方向子树。 */
function importsDirection(file: string, dir: "asr" | "tts"): boolean {
  return importSpecifiers(file).some((spec) => new RegExp(`(^|/)${dir}/`).test(spec));
}

const rel = (file: string) => file.slice(ROOT.length);

test("架构：core/ 不得依赖任何方向", () => {
  const offenders = walk(join(SRC, "core")).filter(
    (f) => importsDirection(f, "asr") || importsDirection(f, "tts"),
  );
  assert.deepEqual(
    offenders.map(rel),
    [],
    "core/ 是方向无关层：不允许 import asr/ 或 tts/（方向类型请放对应方向的 types.ts）",
  );
});

test("架构：两个方向互不依赖", () => {
  const asrInto = walk(join(SRC, "asr")).filter((f) => importsDirection(f, "tts"));
  const ttsInto = walk(join(SRC, "tts")).filter((f) => importsDirection(f, "asr"));
  assert.deepEqual(asrInto.map(rel), [], "asr/ 不应依赖 tts/");
  assert.deepEqual(ttsInto.map(rel), [], "tts/ 不应依赖 asr/");
});

test("架构：两个方向结构对称", () => {
  const expected = [
    // core：传输无关的设施
    "src/core/types.ts",
    "src/core/speech-client.ts",
    "src/core/session.ts",
    "src/core/reconnect.ts",
    // asr：方向子树（目前全是长连接）
    "src/asr/types.ts",
    "src/asr/realtime-asr-client.ts",
    "src/asr/adapters",
    // tts：方向基类 + 两种传输实现
    "src/tts/types.ts",
    "src/tts/tts-client.ts",
    "src/tts/realtime-tts-client.ts",
    "src/tts/http-tts-client.ts",
    "src/tts/adapters",
  ];
  for (const p of expected) {
    assert.ok(existsSync(join(ROOT, p)), `缺少 ${p}`);
  }

  // 每个方向都必须有自己的适配器目录，且里面真的有适配器
  for (const dir of ["asr", "tts"]) {
    const adapters = walk(join(SRC, dir, "adapters")).filter((f) => f.endsWith(".ts"));
    assert.ok(adapters.length > 0, `src/${dir}/adapters/ 下没有任何适配器`);
  }

  // 测试目录与 src 同构
  for (const dir of ["asr", "tts", "common"]) {
    assert.ok(existsSync(join(ROOT, "test", dir)), `缺少 test/${dir}/`);
  }
});

test("架构：类型按方向拆分，且包根完整汇聚（公开导出面）", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  for (const mod of ["core/types", "asr/types", "tts/types"]) {
    assert.match(
      index,
      new RegExp(`export \\* from "\\./${mod}\\.js"`),
      `src/index.ts 应汇聚 ./${mod}.js，否则拆出去的公开类型会从包根消失`,
    );
  }
  // 旧的混装 types.ts 不应复活
  assert.ok(
    !existsSync(join(SRC, "types.ts")),
    "src/types.ts 已按方向拆分（core/asr/tts），不要再放回来",
  );
});
