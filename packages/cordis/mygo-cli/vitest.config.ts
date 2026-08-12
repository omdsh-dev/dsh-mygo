/**
 * mygo-cli 测试配置：独立于主套件运行；把本测试图会用到的 @deepseek-ai/*
 * 显式映射到 checkout 源码，避免依赖未安装的包级 node_modules。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-mygo': here('../mygo/src/index.ts'),
      '@deepseek-ai/dsh-mygo-api': here('../../core/mygo-api/src/index.ts'),
      '@deepseek-ai/cordis': here('../../../vendor/cordis/src'),
      '@deepseek-ai/cordis-plugin-loader': here('../../../vendor/loader/src'),
      '@deepseek-ai/cordis-plugin-include': here('../../../vendor/include/src'),
      '@deepseek-ai/dsh-storage': here('../../storage/storage/src/index.ts'),
      '@deepseek-ai/dsh-storage-domain': here('../../storage/storage-domain/src/index.ts'),
      '@deepseek-ai/dsh-storage-json': here('../../storage/storage-json/src/index.ts'),
      '@deepseek-ai/dsh-storage-sqlite': here('../../storage/storage-sqlite/src/index.ts'),
      '@deepseek-ai/dsh-system-prompt': here('../../core/system-prompt/src/index.ts'),
      '@deepseek-ai/dsh-tools': here('../../core/tools/src/index.ts'),
    },
  },
  test: {
    root: here('.'),
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
