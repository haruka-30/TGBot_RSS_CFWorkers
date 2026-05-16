/**
 * Telegram Bot API 封装
 */

const API_BASE = 'https://api.telegram.org/bot';

export class TelegramBot {
  constructor(token) {
    this.token = token;
    this.baseUrl = `${API_BASE}${token}`;
  }

  async request(method, params = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const result = await response.json();
    if (!result.ok) {
      console.error(`Telegram API error [${method}]:`, result.description);
    }
    return result;
  }

  async setWebhook(url) {
    return this.request('setWebhook', { url });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || undefined,
      disable_web_page_preview: options.disablePreview || false,
      reply_markup: options.replyMarkup || undefined
    });
  }

  async sendHTML(chatId, text, options = {}) {
    return this.sendMessage(chatId, text, {
      ...options,
      parseMode: 'HTML'
    });
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return this.request('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parseMode || undefined,
      disable_web_page_preview: options.disablePreview || false,
      reply_markup: options.replyMarkup || undefined
    });
  }

  async editHTML(chatId, messageId, text, options = {}) {
    return this.editMessageText(chatId, messageId, text, {
      ...options,
      parseMode: 'HTML'
    });
  }

  async sendPhoto(chatId, photoUrl, caption, options = {}) {
    return this.request('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined
    });
  }

  async answerCallbackQuery(callbackQueryId, text = '') {
    return this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
  }

  async deleteMessage(chatId, messageId) {
    return this.request('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  }
}
