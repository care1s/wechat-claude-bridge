/**
 * 会话存储管理
 * 维护每个微信用户的对话历史和 context_token
 * @author carels
 */
import { config } from './config.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const DATA_FILE = join(DATA_DIR, 'sessions.json');

// 确保目录存在
import { mkdirSync } from 'node:fs';
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export class SessionStore {
  constructor() {
    // userId -> { messages: [], contextToken: string, lastActive: timestamp }
    this.sessions = new Map();
    this.tokenMap = new Map(); // accountId:userId -> contextToken

    // 从文件加载
    this.loadFromFile();
  }

  /**
   * 从文件加载会话数据
   */
  loadFromFile() {
    if (existsSync(DATA_FILE)) {
      try {
        const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
        if (data.tokens) {
          for (const [key, token] of Object.entries(data.tokens)) {
            this.tokenMap.set(key, token);
          }
        }
        if (data.sessions) {
          for (const [key, session] of Object.entries(data.sessions)) {
            this.sessions.set(key, session);
          }
        }
        console.log(`[调试] 已从文件加载 ${this.tokenMap.size} 个 token`);
      } catch (e) {
        console.error('加载会话文件失败:', e.message);
      }
    }
  }

  /**
   * 保存到文件
   */
  saveToFile() {
    try {
      const data = {
        tokens: Object.fromEntries(this.tokenMap),
        sessions: Object.fromEntries(this.sessions),
        savedAt: new Date().toISOString(),
      };
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('保存会话文件失败:', e.message);
    }
  }

  /**
   * 获取会话 key
   */
  getKey(accountId, userId) {
    return `${accountId}:${userId}`;
  }

  /**
   * 获取或创建会话
   */
  getSession(accountId, userId) {
    const key = this.getKey(accountId, userId);

    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        messages: [],
        contextToken: null,
        lastActive: Date.now(),
      });
    }

    return this.sessions.get(key);
  }

  /**
   * 更新 context_token
   */
  setContextToken(accountId, userId, token) {
    const session = this.getSession(accountId, userId);
    session.contextToken = token;
    this.tokenMap.set(this.getKey(accountId, userId), token);
    this.saveToFile(); // 持久化保存
  }

  /**
   * 获取 context_token
   */
  getContextToken(accountId, userId) {
    return this.tokenMap.get(this.getKey(accountId, userId));
  }

  /**
   * 添加消息到历史
   */
  addMessage(accountId, userId, role, content) {
    const session = this.getSession(accountId, userId);
    session.messages.push({ role, content });
    session.lastActive = Date.now();

    // 控制历史长度
    if (session.messages.length > config.maxHistoryLength * 2) {
      session.messages = session.messages.slice(-config.maxHistoryLength * 2);
    }
  }

  /**
   * 获取消息历史
   */
  getHistory(accountId, userId) {
    const session = this.getSession(accountId, userId);
    return session.messages;
  }

  /**
   * 清空会话
   */
  clearSession(accountId, userId) {
    const key = this.getKey(accountId, userId);
    this.sessions.delete(key);
    this.tokenMap.delete(key);
  }

  /**
   * 清理过期会话（可选）
   */
  cleanupExpired(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActive > maxAgeMs) {
        this.sessions.delete(key);
        this.tokenMap.delete(key);
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      tokens: this.tokenMap.size,
    };
  }
}

// 单例
export const sessionStore = new SessionStore();
