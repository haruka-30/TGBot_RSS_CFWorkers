/**
 * Telegram 消息处理器
 */

import { Storage } from './storage.js';
import { EmailSender } from './email.js';
import { RSSChecker } from './rss.js';

// ========== 命令处理 ==========

export async function handleCommand(bot, message, env) {
  const userId = message.from.id;
  const command = message.text.split('@')[0].substring(1).split(' ')[0];
  const storage = new Storage(env.KV);

  switch (command) {
    case 'start':
      await storage.clearUserState(userId);
      await showMainMenu(bot, userId, message.from.first_name, 0);
      break;
    case 'help':
      await showHelp(bot, userId, 0);
      break;
    default:
      await bot.sendMessage(userId, `未知命令: ${command}\n请使用 /start 查看菜单或 /help 获取帮助`);
  }
}

// ========== 回调处理 ==========

export async function handleCallback(bot, callbackQuery, env) {
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;
  const from = callbackQuery.from.first_name || '';
  const storage = new Storage(env.KV);

  // 清除用户状态 (除了需要输入的操作)
  if (!['add_keyword', 'add_subscription', 'set_smtp', 'add_email', 'set_smtp_host',
    'set_smtp_port', 'set_smtp_user', 'set_smtp_pass', 'set_smtp_from',
    'set_email_mode', 'set_api_key', 'set_api_url'].includes(data)) {
    await storage.clearUserState(userId);
  }

  switch (data) {
    case 'back_to_menu':
      await showMainMenu(bot, userId, from, messageId);
      break;

    // 关键词管理
    case 'add_keyword':
      await storage.setUserState(userId, { action: 'add_keyword', messageId });
      await editMessage(bot, userId, messageId,
        '请输入要添加的关键词，多个关键词可用逗号或空格分隔：\n\n' +
        '💡 技巧：\n' +
        '• * 可匹配任意字符\n' +
        '• -关键词 表示屏蔽\n' +
        '• #t关键词 只匹配标题\n' +
        '• #c关键词 只匹配描述\n' +
        '• #a关键词 匹配标题和描述\n' +
        '• 关键词+RSS名称 指定RSS源\n' +
        '• 全推送可用 * 号',
        backButton());
      break;

    case 'view_keywords':
      await viewKeywords(bot, storage, userId, messageId);
      break;

    case 'delete_keyword':
      await showDeleteKeywords(bot, storage, userId, messageId);
      break;

    // 订阅管理
    case 'add_subscription':
      await storage.setUserState(userId, { action: 'add_subscription', messageId });
      await editMessage(bot, userId, messageId,
        '✏️ 添加新订阅：\n\n请按以下格式输入RSS订阅信息：\nURL 名称 频道模式(0或1)\n\n' +
        '📝 示例：\n常规订阅：https://example.com/feed 科技新闻 0\n频道订阅：https://example.com/feed TG资讯 1',
        backButton());
      break;

    case 'view_subscriptions':
      await viewSubscriptions(bot, storage, userId, messageId);
      break;

    case 'delete_subscription':
      await showDeleteSubscriptions(bot, storage, userId, messageId);
      break;

    // 邮件推送管理
    case 'email_menu':
      await showEmailMenu(bot, storage, userId, messageId);
      break;

    case 'email_config':
      await showEmailConfig(bot, storage, userId, messageId);
      break;

    case 'set_email_mode':
      await storage.setUserState(userId, { action: 'set_email_mode', messageId });
      await editMessage(bot, userId, messageId,
        '📧 选择邮件发送模式：\n\n' +
        '1️⃣ mailchannels - Cloudflare 免费邮件 (需域名DNS配置)\n' +
        '2️⃣ resend - Resend API\n' +
        '3️⃣ sendgrid - SendGrid API\n' +
        '4️⃣ custom - 自定义 API\n\n' +
        '请输入模式名称 (如: resend):',
        backButton());
      break;

    case 'set_smtp_from':
      await storage.setUserState(userId, { action: 'set_smtp_from', messageId });
      await editMessage(bot, userId, messageId,
        '📧 请输入发件人邮箱地址：\n\n例如: noreply@yourdomain.com',
        backButton());
      break;

    case 'set_api_key':
      await storage.setUserState(userId, { action: 'set_api_key', messageId });
      await editMessage(bot, userId, messageId,
        '🔑 请输入 API Key：\n\n(Resend/SendGrid 的 API Key)',
        backButton());
      break;

    case 'set_api_url':
      await storage.setUserState(userId, { action: 'set_api_url', messageId });
      await editMessage(bot, userId, messageId,
        '🔗 请输入自定义 API URL：\n\n(仅 custom 模式需要)',
        backButton());
      break;

    case 'set_from_name':
      await storage.setUserState(userId, { action: 'set_from_name', messageId });
      await editMessage(bot, userId, messageId,
        '✏️ 请输入发件人名称：\n\n例如: TGBot RSS',
        backButton());
      break;

    case 'email_enable':
      await toggleEmail(bot, storage, userId, messageId, true);
      break;

    case 'email_disable':
      await toggleEmail(bot, storage, userId, messageId, false);
      break;

    case 'email_test':
      await testEmail(bot, storage, userId, messageId);
      break;

    case 'email_recipients':
      await showEmailRecipients(bot, storage, userId, messageId);
      break;

    case 'add_email':
      await storage.setUserState(userId, { action: 'add_email', messageId });
      await editMessage(bot, userId, messageId,
        '📬 请输入要添加的收件人邮箱地址：\n\n例如: user@example.com',
        backButton());
      break;

    case 'help':
      await showHelp(bot, userId, messageId);
      break;

    default:
      // 处理删除操作
      if (data.startsWith('del_kw_')) {
        const keyword = data.substring(7);
        await deleteKeyword(bot, storage, userId, messageId, keyword);
      } else if (data.startsWith('del_sub_')) {
        const subName = data.substring(8);
        await deleteSubscription(bot, storage, userId, messageId, subName);
      } else if (data.startsWith('del_email_')) {
        const email = data.substring(10);
        await deleteEmailRecipient(bot, storage, userId, messageId, email);
      }
  }
}

// ========== 消息处理 (用户输入) ==========

export async function handleMessage(bot, message, env) {
  const userId = message.from.id;
  const text = (message.text || '').trim();
  const storage = new Storage(env.KV);

  if (!text) return;

  const state = await storage.getUserState(userId);
  if (!state) {
    await bot.sendMessage(userId, '请使用 /start 查看功能菜单');
    return;
  }

  switch (state.action) {
    case 'add_keyword': {
      // 处理逗号和空格分隔
      const keywords = text.replace(/，/g, ',').split(/[,\s]+/).filter(k => k.trim());
      if (keywords.length === 0) {
        await bot.sendMessage(userId, '❌ 请输入有效的关键词');
        return;
      }
      const result = await storage.addKeywords(userId, keywords);
      await storage.clearUserState(userId);

      const keywordList = result.keywords.map((kw, i) => `${i + 1}.${kw}`).join('  ');
      await bot.sendMessage(userId,
        `✅ 成功添加 ${result.addedCount} 个关键词\n当前共有 ${result.total} 个关键词\n\n📋 关键词列表：\n${keywordList}`,
        { replyMarkup: backButton() });
      break;
    }

    case 'add_subscription': {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await bot.sendMessage(userId,
          '❌ 格式错误！请按照格式输入：\nURL 名称 频道模式(0或1)\n例如：https://example.com/feed 科技新闻 0');
        return;
      }

      const [url, name, channel] = [parts[0], parts[1], parts[2]];

      // 验证 URL
      try {
        const urlObj = new URL(url);
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          throw new Error('invalid protocol');
        }
      } catch {
        await bot.sendMessage(userId, '❌ 无效的URL格式，请使用http或https开头的完整URL');
        return;
      }

      // 验证 RSS 源
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TGBot-RSS/2.0)' }
        });
        if (!response.ok) {
          await bot.sendMessage(userId, `❌ RSS源请求失败: HTTP ${response.status}`);
          return;
        }
        const content = await response.text();
        if (!content.includes('<rss') && !content.includes('<feed') && !content.includes('<?xml')) {
          await bot.sendMessage(userId, '❌ 未检测到有效的RSS/Atom格式');
          return;
        }
      } catch (e) {
        await bot.sendMessage(userId, `❌ RSS源验证失败: ${e.message}`);
        return;
      }

      try {
        await storage.addSubscription(url, name, channel, userId);
        await storage.clearUserState(userId);
        await bot.sendMessage(userId,
          `✅ 成功添加订阅：\n📰 ${name}\n🔗 ${url}`,
          { replyMarkup: backButton() });
      } catch (e) {
        await bot.sendMessage(userId, `❌ ${e.message}`);
      }
      break;
    }

    case 'set_email_mode': {
      const validModes = ['mailchannels', 'resend', 'sendgrid', 'custom'];
      const mode = text.toLowerCase();
      if (!validModes.includes(mode)) {
        await bot.sendMessage(userId, `❌ 无效的模式，请输入: ${validModes.join(', ')}`);
        return;
      }
      const config = await storage.getSmtpConfig() || {};
      config.mode = mode;
      if (mode === 'resend' || mode === 'sendgrid') {
        config.apiType = mode;
      } else if (mode === 'custom') {
        config.apiType = 'custom';
      }
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 邮件模式已设置为: ${mode}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_smtp_from': {
      if (!text.includes('@')) {
        await bot.sendMessage(userId, '❌ 请输入有效的邮箱地址');
        return;
      }
      const config = await storage.getSmtpConfig() || {};
      config.fromEmail = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 发件人邮箱已设置为: ${text}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_from_name': {
      const config = await storage.getSmtpConfig() || {};
      config.fromName = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 发件人名称已设置为: ${text}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_api_key': {
      const config = await storage.getSmtpConfig() || {};
      config.apiKey = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, '✅ API Key 已设置', { replyMarkup: backButton() });
      break;
    }

    case 'set_api_url': {
      try {
        new URL(text);
      } catch {
        await bot.sendMessage(userId, '❌ 请输入有效的URL');
        return;
      }
      const config = await storage.getSmtpConfig() || {};
      config.apiUrl = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ API URL 已设置为: ${text}`, { replyMarkup: backButton() });
      break;
    }

    case 'add_email': {
      if (!text.includes('@') || !text.includes('.')) {
        await bot.sendMessage(userId, '❌ 请输入有效的邮箱地址');
        return;
      }
      try {
        await storage.addEmailRecipient(text.toLowerCase());
        await storage.clearUserState(userId);
        await bot.sendMessage(userId, `✅ 收件人已添加: ${text}`, { replyMarkup: backButton() });
      } catch (e) {
        await bot.sendMessage(userId, `❌ ${e.message}`);
      }
      break;
    }

    default:
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, '请使用 /start 查看功能菜单');
  }
}

// ========== UI 组件 ==========

async function showMainMenu(bot, userId, from, messageId) {
  const menuText =
    `👋 欢迎使用 TGBot RSS 订阅机器人！\n\n` +
    `👤 ${from || '用户'} (<code>${userId}</code>)\n\n` +
    `1️⃣ 订阅管理：增加/删除/查看 RSS 源\n` +
    `2️⃣ 关键词管理：增加/删除/查看 关键词\n` +
    `3️⃣ 📧 邮件推送：配置邮件通知\n\n` +
    `请选择以下操作：`;

  const keyboard = mainMenuKeyboard();

  if (messageId) {
    await bot.editHTML(userId, messageId, menuText, { replyMarkup: keyboard });
  } else {
    await bot.sendHTML(userId, menuText, { replyMarkup: keyboard });
  }
}

async function showHelp(bot, userId, messageId) {
  const helpText =
    `🤖 RSS订阅机器人 (Cloudflare Workers 版)\n\n` +
    `📝 <b>使用帮助</b>\n\n` +
    `🔤 <b>关键词基础</b>\n` +
    `• 支持中英文，可用逗号或空格分隔多个关键词\n\n` +
    `🎯 <b>高级匹配</b>\n` +
    `• <code>*</code> 可匹配任意字符\n` +
    `• <code>-关键词</code> 表示屏蔽\n` +
    `• <code>#t关键词</code> 只匹配标题\n` +
    `• <code>#c关键词</code> 只匹配描述\n` +
    `• <code>#a关键词</code> 匹配标题和描述\n\n` +
    `📡 <b>RSS过滤</b>\n` +
    `• <code>关键词+RSS名称</code> 只匹配指定RSS源\n\n` +
    `📧 <b>邮件推送</b>\n` +
    `• 支持 MailChannels / Resend / SendGrid\n` +
    `• 在菜单中配置邮件服务即可同步推送到邮箱\n\n` +
    `📦 源码: github.com/IonRh/TGBot_RSS`;

  if (messageId) {
    await bot.editHTML(userId, messageId, helpText, { replyMarkup: backButton(), disablePreview: true });
  } else {
    await bot.sendHTML(userId, helpText, { replyMarkup: backButton(), disablePreview: true });
  }
}

// ========== 关键词操作 ==========

async function viewKeywords(bot, storage, userId, messageId) {
  const keywords = await storage.getKeywords(userId);
  if (keywords.length === 0) {
    await editMessage(bot, userId, messageId, '你还没有添加任何关键词\n\n点击 📝 添加关键词 开始使用', backButton());
    return;
  }

  const list = keywords.sort().map((kw, i) => `${i + 1}.<code>${kw}</code>`).join('  ');
  const text = `📋 你的关键词列表（共 ${keywords.length} 个）：\n\n${list}`;
  await bot.editHTML(userId, messageId, text, { replyMarkup: backButton() });
}

async function showDeleteKeywords(bot, storage, userId, messageId) {
  const keywords = await storage.getKeywords(userId);
  if (keywords.length === 0) {
    await editMessage(bot, userId, messageId, '你还没有添加任何关键词', backButton());
    return;
  }

  const keyboard = createDeleteKeyboard(keywords.sort(), 'del_kw');
  await editMessage(bot, userId, messageId, '请选择要删除的关键词：', keyboard);
}

async function deleteKeyword(bot, storage, userId, messageId, keyword) {
  try {
    const remaining = await storage.removeKeyword(userId, keyword);
    await editMessage(bot, userId, messageId,
      `✅ 关键词 "${keyword}" 已删除\n当前剩余 ${remaining.length} 个关键词`,
      backButton());
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

// ========== 订阅操作 ==========

async function viewSubscriptions(bot, storage, userId, messageId) {
  const subs = await storage.getSubscriptionsForUser(userId);
  if (subs.length === 0) {
    await editMessage(bot, userId, messageId, '你还没有添加任何订阅\n\n点击 ➕ 添加订阅 开始使用', backButton());
    return;
  }

  const list = subs.map((sub, i) => `订阅${i + 1}.<code>${sub.name}</code>\n${sub.url}`).join('\n');
  const text = `📰 你的订阅列表（共 ${subs.length} 个）：\n\n${list}`;
  await bot.editHTML(userId, messageId, text, { replyMarkup: backButton() });
}

async function showDeleteSubscriptions(bot, storage, userId, messageId) {
  const subs = await storage.getSubscriptionsForUser(userId);
  if (subs.length === 0) {
    await editMessage(bot, userId, messageId, '你还没有添加任何订阅', backButton());
    return;
  }

  const names = subs.map(s => s.name);
  const keyboard = createDeleteKeyboard(names, 'del_sub');
  await editMessage(bot, userId, messageId, '请选择要删除的订阅：', keyboard);
}

async function deleteSubscription(bot, storage, userId, messageId, subName) {
  try {
    await storage.removeSubscription(subName, userId);
    await editMessage(bot, userId, messageId, `✅ 订阅 "${subName}" 已删除`, backButton());
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

// ========== 邮件推送操作 ==========

async function showEmailMenu(bot, storage, userId, messageId) {
  const config = await storage.getSmtpConfig();
  const recipients = await storage.getEmailRecipients();

  let statusText = '❌ 未配置';
  if (config) {
    statusText = config.enabled ? '✅ 已启用' : '⏸️ 已暂停';
    statusText += `\n📤 模式: ${config.mode || '未设置'}`;
    statusText += `\n📧 发件人: ${config.fromEmail || '未设置'}`;
    statusText += `\n👥 收件人: ${recipients.length} 个`;
  }

  const text = `📧 邮件推送管理\n\n状态: ${statusText}\n\n请选择操作：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '⚙️ 配置邮件服务', callback_data: 'email_config' },
        { text: '👥 收件人管理', callback_data: 'email_recipients' }
      ],
      [
        { text: '✅ 启用推送', callback_data: 'email_enable' },
        { text: '⏸️ 暂停推送', callback_data: 'email_disable' }
      ],
      [
        { text: '🧪 发送测试邮件', callback_data: 'email_test' }
      ],
      [
        { text: '🔙 返回主菜单', callback_data: 'back_to_menu' }
      ]
    ]
  };

  await editMessage(bot, userId, messageId, text, keyboard);
}

async function showEmailConfig(bot, storage, userId, messageId) {
  const config = await storage.getSmtpConfig() || {};

  const text =
    `⚙️ 邮件服务配置\n\n` +
    `当前配置：\n` +
    `• 模式: ${config.mode || '未设置'}\n` +
    `• 发件人: ${config.fromEmail || '未设置'}\n` +
    `• 发件人名称: ${config.fromName || 'TGBot RSS'}\n` +
    `• API Key: ${config.apiKey ? '已设置 ✅' : '未设置 ❌'}\n` +
    `• API URL: ${config.apiUrl || '(默认)'}\n\n` +
    `请选择要配置的项目：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📡 设置模式', callback_data: 'set_email_mode' },
        { text: '📧 设置发件人', callback_data: 'set_smtp_from' }
      ],
      [
        { text: '✏️ 发件人名称', callback_data: 'set_from_name' },
        { text: '🔑 设置API Key', callback_data: 'set_api_key' }
      ],
      [
        { text: '🔗 设置API URL', callback_data: 'set_api_url' }
      ],
      [
        { text: '🔙 返回邮件菜单', callback_data: 'email_menu' }
      ]
    ]
  };

  await editMessage(bot, userId, messageId, text, keyboard);
}

async function showEmailRecipients(bot, storage, userId, messageId) {
  const recipients = await storage.getEmailRecipients();

  let text = `👥 收件人列表 (${recipients.length} 个)：\n\n`;
  if (recipients.length === 0) {
    text += '暂无收件人，请添加';
  } else {
    text += recipients.map((r, i) => `${i + 1}. ${r}`).join('\n');
  }

  const rows = [];
  // 添加删除按钮
  if (recipients.length > 0) {
    const deleteButtons = recipients.map(r => ({
      text: `❌ ${r}`,
      callback_data: `del_email_${r}`
    }));
    // 每行最多2个按钮
    for (let i = 0; i < deleteButtons.length; i += 2) {
      rows.push(deleteButtons.slice(i, i + 2));
    }
  }

  rows.push([{ text: '➕ 添加收件人', callback_data: 'add_email' }]);
  rows.push([{ text: '🔙 返回邮件菜单', callback_data: 'email_menu' }]);

  await editMessage(bot, userId, messageId, text, { inline_keyboard: rows });
}

async function toggleEmail(bot, storage, userId, messageId, enabled) {
  const config = await storage.getSmtpConfig() || {};
  config.enabled = enabled;
  await storage.saveSmtpConfig(config);
  await showEmailMenu(bot, storage, userId, messageId);
}

async function testEmail(bot, storage, userId, messageId) {
  const emailSender = new EmailSender(storage);
  const result = await emailSender.testEmail();

  if (result.success) {
    await editMessage(bot, userId, messageId, '✅ 测试邮件发送成功！请检查收件箱。', backButton());
  } else {
    await editMessage(bot, userId, messageId, `❌ 测试邮件发送失败：\n${result.error}`, backButton());
  }
}

async function deleteEmailRecipient(bot, storage, userId, messageId, email) {
  try {
    await storage.removeEmailRecipient(email);
    await showEmailRecipients(bot, storage, userId, messageId);
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

// ========== 工具函数 ==========

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📝 添加关键词', callback_data: 'add_keyword' },
        { text: '📋 查看关键词', callback_data: 'view_keywords' }
      ],
      [
        { text: '🗑️ 删除关键词', callback_data: 'delete_keyword' }
      ],
      [
        { text: '➕ 添加订阅', callback_data: 'add_subscription' },
        { text: '📰 查看订阅', callback_data: 'view_subscriptions' }
      ],
      [
        { text: '🗑️ 删除订阅', callback_data: 'delete_subscription' },
        { text: '📧 邮件推送', callback_data: 'email_menu' }
      ],
      [
        { text: 'ℹ️ 关于/帮助', callback_data: 'help' }
      ]
    ]
  };
}

function backButton() {
  return {
    inline_keyboard: [
      [{ text: '🔙 返回主菜单', callback_data: 'back_to_menu' }]
    ]
  };
}

function createDeleteKeyboard(items, prefix) {
  const rows = [];
  const buttonsPerRow = 3;

  for (let i = 0; i < items.length; i += buttonsPerRow) {
    const row = items.slice(i, i + buttonsPerRow).map(item => ({
      text: `❌ ${item}`,
      callback_data: `${prefix}_${item}`
    }));
    rows.push(row);
  }

  rows.push([{ text: '🔙 返回主菜单', callback_data: 'back_to_menu' }]);
  return { inline_keyboard: rows };
}

async function editMessage(bot, userId, messageId, text, replyMarkup) {
  if (messageId) {
    await bot.editMessageText(userId, messageId, text, { replyMarkup });
  } else {
    await bot.sendMessage(userId, text, { replyMarkup });
  }
}
