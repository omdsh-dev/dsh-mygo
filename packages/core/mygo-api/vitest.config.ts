/**
 * 包级测试配置（官方 plugin-template vitest.config.ts 的 dsh-mygo 适配）：
 * 独立于 checkout 根配置运行本包测试；@deepseek-ai/* 显式映射到 checkout
 * 源码，避免解析到未安装的包级 node_modules 或 lib 产物双实例。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-mygo-api/invariant': here('./src/invariant.ts'),
      '@deepseek-ai/cordis': here('../../../vendor/cordis/src'),
      '@deepseek-ai/dsh-invariants': here('../../support/invariants/src/index.ts'),
      '@deepseek-ai/dsh-mygo-api': here('./src/index.ts'),
      '@deepseek-ai/dsh-session/types': here('../../core/session/src/types.ts'),
    },
  },
  test: {
    root: here('.'),
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
