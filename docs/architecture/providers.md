# Provider 抽象层

> 状态：草案 · 最后更新：2026-09-08
>
> 定义多模型接入的统一抽象。目标：Agent 引擎面向**一个稳定接口**编程，各家模型（Claude / OpenAI / Ollama / OpenAI 协议兼容）以适配器接入，能力差异在此层抹平或降级。对应包：`@deva/providers`。

## 1. 目标与非目标

**目标**
- 统一「对话 + 工具调用 + 流式 + 多模态 + 用量」的接口。
- 适配器可插拔，新增一家模型不改动 Agent 引擎。
- 能力探测与降级：不同模型对工具调用/多模态/推理参数支持不一，抽象层负责协商与兜底。

**非目标**
- 不追求覆盖每家模型的全部私有特性（私有能力经可选扩展点暴露）。
- 不做模型路由/负载均衡的复杂策略（初期仅「按配置选择」）。

## 2. 支持矩阵（初期）

| Provider | 传输 | 工具调用 | 流式 | 多模态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Anthropic（Claude，默认） | 官方 SDK | ✅ | ✅ | ✅（图像） | 首选，能力最全对齐 |
| OpenAI | 官方 SDK | ✅ | ✅ | ✅ | function/tool calling |
| OpenAI 协议兼容端点 | HTTP | ✅（视端点） | ✅ | 视端点 | 自定义 baseURL / key |
| Ollama（本地） | HTTP | 视模型 | ✅ | 视模型 | 本地私有、离线 |

> 兼容端点覆盖大量「OpenAI 协议」的第三方/自建服务（如各类网关、vLLM 的 OpenAI 兼容 API）。

## 3. 统一接口（设计草案）

以下为**形状示意**（TypeScript），最终以 `@deva/providers` 实现为准。

```ts
// 一次生成请求（与具体厂商无关）
interface GenerateRequest {
  model: string;
  system?: string;
  messages: Message[];              // 归一化的消息序列
  tools?: ToolSpec[];               // 归一化的工具声明
  toolChoice?: 'auto' | 'none' | { name: string };
  maxTokens?: number;
  temperature?: number;
  // 推理/思考、responseFormat 等可选，能力探测后使用
  signal?: AbortSignal;             // 取消
}

// 统一的流式事件（Agent 引擎只消费这套事件）
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'thinking_delta'; text: string }      // 若模型支持
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; error: NormalizedError }
  | { type: 'done'; stopReason: StopReason };

interface Provider {
  readonly id: string;                          // 'anthropic' | 'openai' | ...
  capabilities(model: string): ModelCapabilities;
  listModels(): Promise<ModelInfo[]>;           // 能力可选
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
  countTokens?(req: GenerateRequest): Promise<number>;
}

interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  thinking: boolean;
  maxContext: number;
  parallelToolCalls: boolean;
}
```

**要点**
- Agent 引擎只依赖 `Provider` 接口与 `StreamEvent`，不感知厂商 SDK 差异。
- 工具调用在抽象层归一：Anthropic 的 `tool_use` / OpenAI 的 `tool_calls` 统一映射为 `tool_call` 事件；执行结果统一以「工具结果消息」回填。
- `AbortSignal` 贯穿到底层请求，支撑 UI 的「停止」。

## 4. 消息与工具的归一化

```mermaid
flowchart LR
    subgraph 归一化域
      M[Message\n(role/content/parts)]
      T[ToolSpec\n(name/desc/jsonSchema)]
      TR[ToolResult]
    end
    M --> A1[Anthropic 适配]
    M --> O1[OpenAI 适配]
    T --> A1
    T --> O1
    A1 --> AN[(Anthropic API)]
    O1 --> OA[(OpenAI/兼容/Ollama)]
    AN --> A2[事件归一化] --> EV[StreamEvent]
    OA --> O2[事件归一化] --> EV
```

- **消息内容**支持多部分（文本、图像、工具调用、工具结果），适配器负责与各家 schema 互转。
- **工具声明**以 JSON Schema 为准（Anthropic `input_schema` / OpenAI `parameters` 皆由此生成）。
- **停止原因**（stopReason）归一：`end_turn` / `tool_use` / `max_tokens` / `stop` / `aborted` / `error`。

## 5. 能力探测与降级

不同模型能力不同，抽象层策略：

| 情况 | 策略 |
| --- | --- |
| 模型不支持工具调用 | 关闭工具或降级为「提示式工具协议」（远期），或提示用户换模型 |
| 不支持并行工具调用 | 串行执行工具循环 |
| 不支持多模态但上下文含图像 | 剥离/转述图像，或阻止并提示 |
| 不支持 thinking | 忽略相关参数 |
| 上下文超限 | 触发上下文压缩/摘要（见 [Agent 引擎](../modules/agent-engine.md)） |

`capabilities(model)` 提供静态能力表 + 运行期探测缓存。

## 6. 配置模型

Provider 与模型的配置分层（全局/工作区/会话，见 [架构总览](./overview.md)）：

```jsonc
// 示意（实际 schema 见实现）
{
  "providers": {
    "anthropic": { "apiKey": "<secret-ref>", "baseURL": null },
    "openai":    { "apiKey": "<secret-ref>" },
    "ollama":    { "baseURL": "http://localhost:11434" },
    "my-gateway":{ "type": "openai-compatible", "baseURL": "https://...", "apiKey": "<secret-ref>" }
  },
  "defaults": { "provider": "anthropic", "model": "<model-id>" }
}
```

- `apiKey` 存的是**凭据引用**，真实密钥在系统凭据库（见 [安全模型](./security.md)）。
- 模型 ID 不硬编码在代码里；通过配置与 `listModels()` 动态获取（对齐「使用最新最强模型」的原则，不写死过期型号）。
- UI 提供 Provider/模型切换、连通性测试、用量显示。

## 7. 用量与成本

- 每次请求汇总 `usage`（输入/输出 token），按会话/任务累计。
- 成本估算依赖各 Provider 的价目表（可配置、可更新），抽象层只负责 token 计量，价目表与展示在上层。
- 多 Provider 下统一在会话视图呈现「本次任务消耗」。

## 8. 错误归一化

```ts
interface NormalizedError {
  kind: 'auth' | 'rate_limit' | 'context_length' | 'network'
      | 'invalid_request' | 'server' | 'aborted' | 'unknown';
  retryable: boolean;
  message: string;        // 用户可读
  raw?: unknown;          // 调试用，脱敏后
}
```

- 各家错误码/异常映射到统一 `kind`，驱动 UI 提示与重试策略（如 `rate_limit` 退避重试，`auth` 引导去改密钥）。

## 9. 扩展新 Provider 的步骤

1. 在 `@deva/providers` 新增适配器实现 `Provider` 接口。
2. 提供 `capabilities` 与消息/工具/事件的双向映射。
3. 注册到 Provider 注册表并补充配置 schema。
4. 加适配器单测（用录制的响应做回归）。
5. 更新本文支持矩阵。

## 10. 待决事项

- 是否引入一层现成的多 Provider SDK（如 Vercel AI SDK）以减少自研，与「完全自控归一化」的取舍——倾向自研薄抽象以精确控制工具调用/权限/取消语义。
- 「提示式工具调用」兜底是否值得做（面向不支持原生 tool calling 的本地模型）。
- 并行工具调用的调度与权限交互顺序。
