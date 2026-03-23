/**
 * AI API 客户端
 * 支持 Anthropic 官方和第三方代理（Coding Plan 等）
 * @author carels
 */
import { config } from './config.js';

export class ClaudeClient {
  constructor() {
    this.apiKey = config.anthropicApiKey;
    this.model = config.claudeModel;
    this.systemPrompt = config.systemPrompt;

    // 检测 API 类型
    this.isThirdParty = this.apiKey.startsWith('sk-sp-') || this.apiKey.startsWith('sk-or-');

    // 第三方代理配置（可配置）
    this.baseUrl = config.apiBaseUrl || 'https://api.chatanywhere.tech/v1';

    console.log(`[调试] API类型: ${this.isThirdParty ? '第三方代理' : 'Anthropic官方'}`);
    if (this.isThirdParty) {
      console.log(`[调试] 代理地址: ${this.baseUrl}`);
    }
  }

  /**
   * 发送消息到 AI
   */
  async chat(messages, options = {}) {
    if (this.isThirdParty) {
      return await this.chatThirdParty(messages, options);
    } else {
      return await this.chatAnthropic(messages, options);
    }
  }

  /**
   * Anthropic 官方 API
   */
  async chatAnthropic(messages, options = {}) {
    // 动态导入 Anthropic SDK
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      system: this.systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options.temperature ?? 0.7,
    });

    return {
      content: response.content[0]?.text || '',
      usage: response.usage,
      stopReason: response.stop_reason,
    };
  }

  /**
   * 第三方代理 API（OpenAI 兼容格式）
   */
  async chatThirdParty(messages, options = {}) {
    // 转换消息格式为 OpenAI 格式
    const openAiMessages = [
      { role: 'system', content: this.systemPrompt },
      ...messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: openAiMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API错误 ${response.status}: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      usage: data.usage,
      stopReason: data.choices[0]?.finish_reason,
    };
  }

  /**
   * 单轮对话（简单场景）
   */
  async ask(userMessage, history = []) {
    const messages = [
      ...history,
      { role: 'user', content: userMessage },
    ];

    return await this.chat(messages);
  }
}

// 单例
let claudeClient = null;

export function getClaudeClient() {
  if (!claudeClient) {
    claudeClient = new ClaudeClient();
  }
  return claudeClient;
}
