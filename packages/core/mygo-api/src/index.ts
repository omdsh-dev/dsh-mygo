/**
 * The Cordis-free upper-level plugin contract: `definePlugin`, manifest and
 * environment types, the `PluginError` vocabulary, and a fake-env test
 * surface. Plugin authors import only this package; the plugin manager
 * bridges these declarations into Cordis at mount time.
 * @module @deepseek-ai/dsh-mygo-api
 */

export { definePlugin } from './define.ts'
export { PluginError, formatPluginError } from './error.ts'
export { createFakeEnv } from './fake.ts'
export { fromCordisPlugin, toCordisPlugin } from './adapter.ts'
export type { AdapterContext, CordisFacade, CordisFunctionPluginShape, RawCordisFunctionPlugin } from './adapter.ts'
export type {
  FakeFetchCallRecord,
  FakeFsWriteRecord,
  FakeListenerRecord,
  FakeLogRecord,
  FakePluginEnv,
  FakePluginEnvOptions,
  FakeProvidedRecord,
} from './fake.ts'
export type {
  DeactivateReason,
  Disposable,
  FileAccessEntry,
  FileAccessMode,
  InstallOptions,
  InstallOrigin,
  InterceptDeclaration,
  Logger,
  PermissionsBlock,
  PluginDefinition,
  PluginDirEntry,
  PluginClientDeclaration,
  PluginCommandDefinition,
  PluginCommandInvocation,
  PluginCommandResult,
  PluginCommands,
  PluginEnv,
  PluginEventArgs,
  PluginEventName,
  PluginEventListener,
  PluginEvents,
  PluginExec,
  PluginExecRequest,
  PluginExecResult,
  PluginFileStat,
  PluginFs,
  PluginHandleInfo,
  PluginHttp,
  PluginHttpMethod,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginHttpRouteSpec,
  PluginModel,
  PluginModelMessage,
  PluginModelRequest,
  PluginModelResponse,
  PluginHooks,
  PluginPromptSection,
  PluginSkillDefinition,
  PluginSkills,
  PluginSource,
  PluginToolDefinition,
  PluginToolExecutionContext,
  PluginToolAgentContext,
  PluginToolSessionContext,
  PluginToolRenderIntent,
  PluginVars,
  PreviousGeneration,
  Schemastery,
  TransformDeclaration,
} from './types.ts'
export type { PluginErrorCode } from './error.ts'
