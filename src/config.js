/**
 * 配置管理
 * @author carels
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

// 加载 .env
dotenv.config();

const CONFIG_DIR = join(homedir(), '.weixin-claude-bridge');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

// 确保配置目录存在
if (!existsSync(CONFIG_DIR)) {
  import('node:fs').then(fs => fs.mkdirSync(CONFIG_DIR, { recursive: true }));
}

export const config = {
  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  apiBaseUrl: process.env.API_BASE_URL,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
  systemPrompt: process.env.SYSTEM_PROMPT || '你是 Claude，一个AI助手。你正在通过微信与用户对话。',

  // 微信
  // 官方网关: https://ilinkai.weixin.qq.com
  weixinBaseUrl: process.env.WEIXIN_BASE_URL || 'https://ilinkai.weixin.qq.com',
  weixinBotToken: process.env.WEIXIN_BOT_TOKEN,
  weixinAccountId: process.env.WEIXIN_ACCOUNT_ID,

  // 访问控制
  allowedUsers: process.env.ALLOWED_USERS?.split(',').filter(Boolean) || [],

  // 会话配置
  maxHistoryLength: parseInt(process.env.MAX_HISTORY_LENGTH || '20'),
  messageTimeout: parseInt(process.env.MESSAGE_TIMEOUT || '30000'),
};

// 从文件加载保存的 token
export function loadSavedToken() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
      config.weixinBotToken = data.token;
      config.weixinAccountId = data.accountId;
      config.weixinBaseUrl = data.baseUrl || config.weixinBaseUrl;
      return true;
    } catch (e) {
      console.error('加载保存的 token 失败:', e.message);
    }
  }
  return false;
}

// 保存 token 到文件
export function saveToken(token, accountId, baseUrl) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({
      token,
      accountId,
      baseUrl,
      savedAt: new Date().toISOString()
    }, null, 2));
    config.weixinBotToken = token;
    config.weixinAccountId = accountId;
    config.weixinBaseUrl = baseUrl;
    console.log('✓ Token 已保存到:', TOKEN_FILE);
  } catch (e) {
    console.error('保存 token 失败:', e.message);
  }
}

// 验证配置
export function validateConfig() {
  if (!config.anthropicApiKey) {
    throw new Error('缺少 ANTHROPIC_API_KEY，请在 .env 文件中配置');
  }
  return true;
}
