# tests/ — mygo-loader-hub 测试

- `registry.spec.ts`：快照解析/摘要校验/Ed25519 验签（本地生成密钥对
  注入）/篡改检测/双 origin 故障转移/NDA 404 降级 vendored/
  insecure-no-verify 规则。
- `intent.spec.ts`：install intent 翻译、可安装判定、治理提示和
  collections 原子安装。
- `adapter.spec.ts`：hub adapter resolve/list/install 委托。
- `fixtures/registry-v1.json`：dsh-hub 真实快照（第三方语料，豁免区）。
