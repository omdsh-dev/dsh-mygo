/**
 * live rail 事件通道（rc8）：`/api/mygo/events` SSE 端点 + 广播面。
 * live 轨装卸成功（含运行期 dispose 验证通过）后向打开中的页面推
 * `{ type: 'live-rail', op, id, url? }` 帧——浏览器半据此页内挂载/拆卸
 * client 行，打开中的页面免刷新。帧格式与 host `/plugins/events` 同款
 * （`data: <json>\n\n`）；host graph 帧不广播（EXT-4 提案未合入），本通道
 * 只承载 mygo 自己 live 轨的操作，与 EXT-4 合入后的 graph 帧并存不冲突
 * （graph 帧管全量图，本帧只管 live 轨操作）。
 * @module @r05en1cu/dsh-mygo-ext-panel/live-events
 */

/** 一帧 live rail 事件（id = graph 行 id = 包名；url = client bundle 地址）。 */
export interface LiveRailFrame {
  readonly type: 'live-rail'
  readonly op: 'mount' | 'unmount'
  readonly id: string
  readonly url?: string
}

/** SSE 连接的最小响应面（面板 RawResponse 之外的写/关闭面）。 */
interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): unknown
  on(event: 'close', listener: () => void): void
}

/** 面板 webServer 注册面（与 index.ts 的 WebServerLike 同形）。 */
interface WebServerLike {
  register(route: {
    kind?: 'exact' | 'prefix'
    path: string
    handler(req: unknown, res: unknown): void | Promise<void>
  }): () => void
}

/** live rail 事件端点路径（client 半订阅同址）。 */
export const LIVE_EVENTS_PATH = '/api/mygo/events'

const connections = new Set<SseResponse>()

/** 当前挂接的 SSE 连接数（测试断言用）。 */
export function liveEventsConnectionCount(): number {
  return connections.size
}

/** 从 host clientModules 图取行 url（服务不可达/行不在图/读图失败 → undefined）。 */
export function liveRowUrlOf(get: (name: string) => unknown, id: string): string | undefined {
  try {
    const modules = get('clientModules') as {
      graph(): { readonly entries: readonly { readonly id: string; readonly url: string }[] }
    } | undefined
    return modules?.graph().entries.find(entry => entry.id === id)?.url
  } catch {
    return undefined
  }
}

/** 广播一帧到全部打开中的页面（无连接时 no-op）。 */
export function broadcastLiveRail(frame: LiveRailFrame): void {
  const line = `data: ${JSON.stringify(frame)}\n\n`
  for (const res of connections) res.write(line)
}

/** 注册 `/api/mygo/events` SSE 端点（exact 先于 /api/mygo prefix 匹配）。 */
export function registerLiveEventsRoute(webServer: WebServerLike): void {
  webServer.register({
    kind: 'exact',
    path: LIVE_EVENTS_PATH,
    handler: (req: unknown, res: unknown) => {
      const method = (req as { readonly method?: unknown }).method
      const response = res as SseResponse
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, {})
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
      })
      // 注释行开路：无帧期间连接也可被客户端/代理视为存活（EventSource
      // 解析天然跳过注释行；与 host /plugins/events 同形态）。
      response.write(': connected\n\n')
      connections.add(response)
      response.on('close', () => { connections.delete(response) })
    },
  })
}
