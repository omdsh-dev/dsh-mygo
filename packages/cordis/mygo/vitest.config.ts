/**
 * 包级测试配置（官方 plugin-template vitest.config.ts 的 dsh-mygo 适配）：
 * 独立于 checkout 根配置运行本包 tests/ 套件；复用 checkout
 * tsconfig.base.json 的 paths 映射（与根配置同一机制），把 @deepseek-ai/*
 * 解析到源码避免 lib 产物双实例。test/eb 假设验证套件保持独立配置
 * （test/eb/vitest.config.ts，刻意走 node_modules lib 产物）。
 */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [here('../../../tsconfig.base.json')] })],
  test: {
    root: here('.'),
    include: ['tests/**/*.spec.ts'],
    // extension-mygo-rdb.spec.ts 以 process.cwd() 拼接临时目录，仅 checkout
    // 根运行成立（mygo-rdb 本地修正文件，按用户裁决不修改）；全量套件仍覆盖。
    exclude: ['tests/extension-mygo-rdb.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
