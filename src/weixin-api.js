/**
 * 微信 API 封装
 * 直接实现 OpenClaw 微信协议
 * @author carels
 */
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT = 35000;

/**
 * 生成 X-WECHAT-UIN 头
 * 随机 uint32 -> 十进制字符串 -> base64
 */
function generateUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * 构建请求头
 */
function buildHeaders(token, body) {
  const headers = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': generateUin(),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

/**
 * 通用 API 请求
 */
async function apiRequest(baseUrl, endpoint, token, body, timeoutMs = DEFAULT_TIMEOUT) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const bodyStr = JSON.stringify(body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(token, bodyStr),
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw err;
  }
}

/**
 * 获取登录二维码
 */
export async function getQRCode(baseUrl, botType = '3') {
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${botType}`,
    baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');

  console.log(`  请求 URL: ${url.toString()}`);

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`获取二维码失败: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error(`  请求失败: ${err.message}`);
    console.error(`  可能原因:`);
    console.error(`    - 网络连接问题`);
    console.error(`    - DNS 解析失败`);
    console.error(`    - 防火墙/代理阻挡`);
    console.error(`    - 微信网关地址不正确`);
    throw err;
  }
}

/**
 * 轮询二维码状态
 */
export async function pollQRStatus(baseUrl, qrcode, timeoutMs = 35000) {
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });

    clearTimeout(timer);

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`轮询状态失败: ${response.status} ${text}`);
    }

    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { status: 'timeout' };
    }
    throw err;
  }
}

/**
 * 获取更新（长轮询）
 */
export async function getUpdates(baseUrl, token, syncBuf = '', timeoutMs = 35000) {
  try {
    const resp = await apiRequest(baseUrl, 'ilink/bot/getupdates', token, {
      get_updates_buf: syncBuf,
    }, timeoutMs);

    return {
      ret: resp.ret ?? 0,
      errcode: resp.errcode,
      errmsg: resp.errmsg,
      msgs: resp.msgs || [],
      syncBuf: resp.get_updates_buf || syncBuf,
      timeoutMs: resp.longpolling_timeout_ms || timeoutMs,
    };
  } catch (err) {
    if (err.message.includes('timeout')) {
      // 长轮询超时是正常的
      return { ret: 0, msgs: [], syncBuf, timeoutMs };
    }
    throw err;
  }
}

/**
 * 发送文本消息
 */
export async function sendTextMessage(baseUrl, token, to, text, contextToken) {
  const msg = {
    from_user_id: "",
    to_user_id: to,
    client_id: generateId(),
    message_type: 2, // BOT
    message_state: 2, // FINISH
    context_token: contextToken,
    item_list: text
      ? [{ type: 1, text_item: { text } }]
      : [],
  };

  console.log('[调试] 发送消息体:', JSON.stringify({
    to_user_id: to,
    client_id: msg.client_id,
    message_type: msg.message_type,
    message_state: msg.message_state,
    context_token_length: contextToken ? contextToken.length : 0,
    text_length: text.length
  }));

  const resp = await apiRequest(baseUrl, 'ilink/bot/sendmessage', token, { msg });
  console.log('[调试] sendmessage 原始响应:', JSON.stringify(resp, null, 2));

  // 检查微信 API 返回码
  if (resp.ret !== undefined && resp.ret !== 0) {
    throw new Error(`微信 API 错误: ret=${resp.ret}, errcode=${resp.errcode}, errmsg=${resp.errmsg || '未知错误'}`);
  }

  return { success: true, raw: resp };
}

/** 生成唯一 ID */
function generateId() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

/**
 * 发送"正在输入"状态
 */
export async function sendTyping(baseUrl, token, userId, typingTicket, status = 1) {
  await apiRequest(baseUrl, 'ilink/bot/sendtyping', token, {
    ilink_user_id: userId,
    typing_ticket: typingTicket,
    status,
  }, 10000);
}

/**
 * 获取用户配置（含 typing ticket）
 */
export async function getConfig(baseUrl, token, userId, contextToken) {
  return await apiRequest(baseUrl, 'ilink/bot/getconfig', token, {
    ilink_user_id: userId,
    context_token: contextToken,
  }, 10000);
}

// 消息类型常量
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
};
