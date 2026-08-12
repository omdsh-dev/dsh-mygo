/**
 * 假设验证实验专用 vitest 配置：只包含 test/eb 目录，
 * 与主套件（tests/**）隔离；依赖经 checkout node_modules 解析到 lib 产物。
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/cordis/mygo/test/eb/**/*.spec.ts'],
  },
})
