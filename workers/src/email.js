/**
 * 邮件推送模块
 * 通过 SMTP 发送邮件通知
 * 
 * 在 Cloudflare Workers 中无法直接使用 SMTP 连接，
 * 因此使用 MailChannels API (Cloudflare Workers 免费邮件发送服务)
 * 或者通过外部 SMTP 中继服务 API 发送
 * 
 * 支持两种模式:
 * 1. MailChannels (免费，需要域名 DNS 配置)
 * 2. 外部 SMTP API 中继 (如 SendGrid, Mailgun, Resend 等)
 */

export class EmailSender {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * 发送邮件
   * @param {string} subject - 邮件主题
   * @param {string} htmlContent - HTML 内容
   * @param {string} textContent - 纯文本内容
   */
  async sendEmail(subject, htmlContent, textContent) {
    const config = await this.storage.getSmtpConfig();
    if (!config || !config.enabled) {
      return { success: false, error: '邮件推送未配置或未启用' };
    }

    const recipients = await this.storage.getEmailRecipients();
    if (recipients.length === 0) {
      return { success: false, error: '没有邮件接收人' };
    }

    try {
      if (config.mode === 'mailchannels') {
        return await this.sendViaMailChannels(config, recipients, subject, htmlContent, textContent);
      } else if (config.mode === 'api') {
        return await this.sendViaAPI(config, recipients, subject, htmlContent, textContent);
      } else {
        return { success: false, error: '未知的邮件发送模式' };
      }
    } catch (e) {
      console.error('发送邮件失败:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * 通过 MailChannels 发送 (Cloudflare Workers 原生支持)
   */
  async sendViaMailChannels(config, recipients, subject, htmlContent, textContent) {
    const toList = recipients.map(email => ({ email, name: '' }));

    const payload = {
      personalizations: [{
        to: toList
      }],
      from: {
        email: config.fromEmail,
        name: config.fromName || 'TGBot RSS'
      },
      subject,
      content: [
        { type: 'text/plain', value: textContent },
        { type: 'text/html', value: htmlContent }
      ]
    };

    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.status === 202 || response.status === 200) {
      return { success: true };
    }

    const errorText = await response.text();
    return { success: false, error: `MailChannels 错误: ${response.status} - ${errorText}` };
  }

  /**
   * 通过外部 API 发送 (支持 Resend / SendGrid / 自定义 API)
   */
  async sendViaAPI(config, recipients, subject, htmlContent, textContent) {
    if (config.apiType === 'resend') {
      return await this.sendViaResend(config, recipients, subject, htmlContent);
    } else if (config.apiType === 'sendgrid') {
      return await this.sendViaSendGrid(config, recipients, subject, htmlContent, textContent);
    } else if (config.apiType === 'custom') {
      return await this.sendViaCustomAPI(config, recipients, subject, htmlContent, textContent);
    }
    return { success: false, error: '未知的 API 类型' };
  }

  /**
   * 通过 Resend API 发送
   */
  async sendViaResend(config, recipients, subject, htmlContent) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${config.fromName || 'TGBot RSS'} <${config.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent
      })
    });

    const result = await response.json();
    if (response.ok) {
      return { success: true };
    }
    return { success: false, error: result.message || JSON.stringify(result) };
  }

  /**
   * 通过 SendGrid API 发送
   */
  async sendViaSendGrid(config, recipients, subject, htmlContent, textContent) {
    const toList = recipients.map(email => ({ email }));

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: toList }],
        from: { email: config.fromEmail, name: config.fromName || 'TGBot RSS' },
        subject,
        content: [
          { type: 'text/plain', value: textContent },
          { type: 'text/html', value: htmlContent }
        ]
      })
    });

    if (response.status === 202 || response.status === 200) {
      return { success: true };
    }
    const errorText = await response.text();
    return { success: false, error: `SendGrid 错误: ${response.status} - ${errorText}` };
  }

  /**
   * 通过自定义 SMTP API 中继发送
   * 支持任何兼容 REST API 的邮件服务
   */
  async sendViaCustomAPI(config, recipients, subject, htmlContent, textContent) {
    const payload = {
      from: config.fromEmail,
      fromName: config.fromName || 'TGBot RSS',
      to: recipients,
      subject,
      html: htmlContent,
      text: textContent
    };

    // 如果配置了自定义 headers
    const headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
      ...(config.customHeaders || {})
    };

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      return { success: true };
    }
    const errorText = await response.text();
    return { success: false, error: `API 错误: ${response.status} - ${errorText}` };
  }

  /**
   * 测试邮件配置
   */
  async testEmail() {
    const subject = '🧪 TGBot RSS 邮件推送测试';
    const html = `
      <h2>✅ 邮件推送配置成功！</h2>
      <p>这是一封测试邮件，说明你的邮件推送配置已经正确设置。</p>
      <p>之后当 RSS 订阅有新内容匹配关键词时，你将同时收到邮件通知。</p>
      <hr>
      <p style="color: #666; font-size: 12px;">TGBot RSS - Cloudflare Workers Edition</p>
    `;
    const text = '✅ 邮件推送配置成功！这是一封测试邮件。';

    return await this.sendEmail(subject, html, text);
  }

  /**
   * 发送 RSS 更新邮件
   */
  async sendRSSUpdate(rssName, messages, matchedKeywords) {
    if (messages.length === 0) return;

    const subject = `📰 RSS 更新: ${rssName} (${messages.length} 条新内容)`;

    let html = `<h2>📰 ${rssName} 有新内容</h2>`;
    html += `<p>匹配关键词: ${matchedKeywords.join(', ')}</p><hr>`;

    let text = `📰 ${rssName} 有新内容\n匹配关键词: ${matchedKeywords.join(', ')}\n\n`;

    for (const msg of messages) {
      html += `
        <div style="margin-bottom: 20px; padding: 10px; border-left: 3px solid #0088cc;">
          <h3><a href="${msg.link}">${msg.title}</a></h3>
          <p style="color: #666; font-size: 12px;">🕒 ${msg.pubDate}</p>
          <p>${msg.description || ''}</p>
        </div>
      `;
      text += `📌 ${msg.title}\n🕒 ${msg.pubDate}\n🔗 ${msg.link}\n\n`;
    }

    html += `<hr><p style="color: #666; font-size: 12px;">TGBot RSS - Cloudflare Workers Edition</p>`;

    return await this.sendEmail(subject, html, text);
  }
}
