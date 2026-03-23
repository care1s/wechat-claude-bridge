/**
 * 微信登录脚本
 * 扫码获取 bot_token
 * @author carels
 */
import qrcode from 'qrcode-terminal';
import { config, saveToken } from './config.js';
import { getQRCode, pollQRStatus } from './weixin-api.js';

const POLL_INTERVAL = 3000;
const MAX_RETRIES = 100;

async function login() {
  console.log('🔄 正在获取微信登录二维码...\n');

  try {
    // 1. 获取二维码
    const qrData = await getQRCode(config.weixinBaseUrl);
    const { qrcode: qrCode, qrcode_img_content } = qrData;

    console.log('请使用微信扫描以下二维码：\n');

    // 显示终端二维码
    try {
      qrcode.generate(qrcode_img_content || qrCode, { small: true }, (qr) => {
        console.log(qr);
      });
    } catch (e) {
      console.log('二维码链接:', qrCode);
    }

    console.log('\n⏳ 等待扫码确认（8分钟超时）...');
    console.log('提示：扫码后在手机上点击"确认"\n');

    // 2. 轮询状态
    let retries = 0;
    let lastStatus = '';

    while (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      const status = await pollQRStatus(config.weixinBaseUrl, qrCode, 35000);

      // 状态变化才打印
      if (status.status !== lastStatus) {
        lastStatus = status.status;
        const statusText = {
          'wait': '等待扫码...',
          'scaned': '已扫码，等待确认...',
          'confirmed': '✓ 已确认！',
          'expired': '✗ 二维码已过期',
          'timeout': '⏱ 轮询超时，重试中...',
        }[status.status] || `未知状态: ${status.status}`;

        console.log(`[${new Date().toLocaleTimeString()}] ${statusText}`);
      }

      // 登录成功
      if (status.status === 'confirmed') {
        if (status.bot_token && status.ilink_bot_id) {
          console.log('\n✅ 登录成功！');
          console.log(`账号 ID: ${status.ilink_bot_id}`);
          console.log(`Base URL: ${status.baseurl || config.weixinBaseUrl}`);
          console.log(`User ID: ${status.ilink_user_id || 'N/A'}`);

          // 保存 token
          saveToken(
            status.bot_token,
            status.ilink_bot_id,
            status.baseurl || config.weixinBaseUrl
          );

          console.log('\n现在可以运行: npm start');
          return;
        } else {
          throw new Error('登录响应缺少必要字段');
        }
      }

      // 二维码过期
      if (status.status === 'expired') {
        throw new Error('二维码已过期，请重新运行登录');
      }

      retries++;
    }

    throw new Error('登录超时，请重新运行');

  } catch (err) {
    console.error('\n❌ 登录失败:', err.message);
    process.exit(1);
  }
}

login();
