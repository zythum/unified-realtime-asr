/**
 * 清空 `dist/`。
 *
 * 为什么需要：`tsc` 只增不减 —— 移动或重命名 `src/` 下的文件后，旧路径的编译产物会留在
 * `dist/` 里（本仓库真实发生过：`dist/adapters/*`、`dist/core/base-client.js` 这类陈旧文件
 * 一直躺着），而 `package.json` 的 `files` 包含 `dist`，于是它们会被一起发布出去。
 * `build` 前先清一次，保证产物与源码一一对应。
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
rmSync(dist, { recursive: true, force: true });
console.log(`[clean] 已清空 ${dist}`);
