/**
 * Шаблон письма-уведомления о входе админа.
 * Чистый модуль без зависимостей: его импортируют и Vite (dev-транспорт
 * /api/login-notify), и Supabase Edge Function supabase/functions/login-notify.
 */

export interface LoginMailPayload {
  adminEmail?: string;
  loginAt?: string;
  userAgent?: string;
  siteUrl?: string;
  ip?: string;
}

export function buildLoginMailSubject(p: LoginMailPayload): string {
  return `Вход админа в Hikkomanga: ${p.adminEmail || 'неизвестный аккаунт'}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      dateStyle: 'full',
      timeStyle: 'long',
    });
  } catch {
    return iso;
  }
}

function shortAgent(ua?: string): string {
  if (!ua) return '—';
  const clean = ua.length > 120 ? ua.slice(0, 117) + '…' : ua;
  return clean;
}

export function buildLoginMailHtml(p: LoginMailPayload): string {
  const site = (p.siteUrl || '').replace(/\/$/, '');
  const ackHref = site ? `${site}/admin` : '#';
  const denyHref = site ? `${site}/admin/login` : '#';

  return `
<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#0a0a0a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="max-width:560px;width:100%;background:#171717;border:1px solid #262626;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px 8px;">
            <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#f43f5e;font-weight:700;">
              Hikkomanga · Login Guard
            </div>
            <h1 style="margin:10px 0 4px;font-size:20px;color:#fafafa;">
              Выполнен вход в админ-панель
            </h1>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#a3a3a3;">
              Кто-то вошёл как администратор через кнопку «Войти».
              Если это были вы — просто подтвердите вход. Если нет — действуйте немедленно.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;font-size:14px;">
              <tr>
                <td style="padding:10px 16px;color:#737373;width:110px;">Аккаунт</td>
                <td style="padding:10px 16px;color:#fafafa;font-weight:600;">${escapeHtml(p.adminEmail || '—')}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">Когда</td>
                <td style="padding:10px 16px;color:#e5e5e5;border-top:1px solid #1f1f1f;">${escapeHtml(formatDate(p.loginAt))}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">IP</td>
                <td style="padding:10px 16px;color:#e5e5e5;border-top:1px solid #1f1f1f;font-family:ui-monospace,monospace;">${escapeHtml(p.ip || 'не определён')}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">Браузер</td>
                <td style="padding:10px 16px;color:#a3a3a3;border-top:1px solid #1f1f1f;font-size:12px;">${escapeHtml(shortAgent(p.userAgent))}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 8px;" align="center">
            <a href="${escapeHtml(ackHref)}"
               style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin:4px 6px;">
              Подтвердить — это я
            </a>
            <a href="${escapeHtml(denyHref)}"
               style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin:4px 6px;">
              Это не я
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 24px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#737373;">
              Если вход совершили не вы: немедленно смените пароль администратора
              (Supabase → Authentication → Users), завершите активные сессии
              и проверьте журнал входов. Письмо отправлено автоматически
              и не требует ответа.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}
