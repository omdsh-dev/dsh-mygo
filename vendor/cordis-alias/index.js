/**
 * Dev-workspace alias: re-export the vendored `cordis` module under the
 * published `@deepseek-ai/cordis` identity. Node resolves `cordis` to the
 * same module instance the host uses, so `Service`/`Context` identity is
 * preserved; published builds import the real @deepseek-ai/cordis package.
 */
export * from 'cordis'
