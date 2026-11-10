import type { JSONSchema } from 'monaco-yaml'

/** Extensions to the upstream schema for the custom Mihomo configuration editor. */
export const customMihomoProperties: Record<string, JSONSchema> = {
  'udp-fallback': {
    type: 'boolean',
    default: true,
    description:
      '命中的出站不支持 UDP 时继续匹配后续规则；false 表示直接失败，仅影响新建 UDP 关联。'
  },
  'hook-providers': {
    type: 'object',
    description: '自定义 Mihomo 的 HOST/IP 事件处理器，只有被 hooks 引用后才会启用。',
    additionalProperties: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['api', 'script'] },
        mode: { type: 'string', enum: ['sync', 'async'], default: 'async' },
        timeout: { type: 'string', default: '2s' },
        'on-error': {
          type: 'string',
          enum: ['block', 'continue'],
          description: '同步默认 block；异步只能 continue。'
        },
        'confirmation-ttl': {
          type: 'string',
          default: '30s',
          description: '同一次操作或 UDP 关联中复用 IP 确认的最长时间。'
        },
        url: { type: 'string', description: 'API 地址，使用 POST JSON，不跟随重定向。' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        'success-status': { type: 'integer', minimum: 100, maximum: 599, default: 200 },
        command: { type: 'string', description: '固定可执行文件路径，事件 JSON 写入 stdin。' },
        args: { type: 'array', items: { type: 'string' } }
      },
      allOf: [
        {
          if: { properties: { type: { const: 'api' } } },
          then: { required: ['url'] }
        },
        {
          if: { properties: { type: { const: 'script' } } },
          then: { required: ['command'] }
        },
        {
          if: { properties: { mode: { const: 'sync' } }, required: ['mode'] },
          else: { properties: { 'on-error': { const: 'continue' } } }
        }
      ]
    }
  },
  hooks: {
    type: 'array',
    description: '独立于业务路由匹配的 HOST/IP hook，按配置顺序执行，匹配时不触发 DNS。',
    items: {
      type: 'object',
      required: ['event', 'match', 'providers'],
      properties: {
        event: { type: 'string', enum: ['HOST', 'IP'] },
        match: { type: 'string', description: '复用 Mihomo 规则条件，不带出站名称。' },
        providers: { type: 'array', minItems: 1, items: { type: 'string' } }
      }
    }
  }
}
