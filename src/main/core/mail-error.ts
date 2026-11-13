export type MailProtocol = 'IMAP' | 'SMTP' | 'POP3';

type MailErrorRecord = {
  code?: unknown;
  hostname?: unknown;
  message?: unknown;
  response?: unknown;
  responseStatus?: unknown;
  responseText?: unknown;
  serverResponseCode?: unknown;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordOf(error: unknown): MailErrorRecord {
  return error && typeof error === 'object' ? error as MailErrorRecord : {};
}

function serverDetail(error: unknown): string {
  const record = recordOf(error);
  return text(record.responseText)
    || text(record.response)
    || text(record.serverResponseCode)
    || '';
}

function withServerDetail(message: string, detail: string): string {
  if (!detail) return message;
  return `${message} 服务器返回：${detail}`;
}

/** Converts protocol errors into an actionable message without exposing credentials. */
export function describeMailError(error: unknown, protocol: MailProtocol): string {
  const record = recordOf(error);
  const message = text(record.message) || String(error);
  const detail = serverDetail(error);
  const status = text(record.responseStatus);
  const code = text(record.code);
  const serverCode = text(record.serverResponseCode);
  const combined = [message, detail, status, code, serverCode].filter(Boolean).join(' ');

  if (/authenticat|AUTHENTICATIONFAILED|LOGIN failed|invalid\s+(login|credentials?)|password|\b535\b/i.test(combined)) {
    const action = protocol === 'IMAP'
      ? '请在设置中更新邮箱密码/授权码，并确认邮箱已开启 IMAP。'
      : '请在设置中更新邮箱密码/授权码。';
    return withServerDetail(`${protocol} 登录失败：邮箱服务商拒绝了该账号。${action}`, detail);
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(combined)) {
    return `${protocol} 连接超时：服务器暂时没有响应，请稍后重试。`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo|EAI_AGAIN|socket hang up/i.test(combined)) {
    const host = text(record.hostname);
    return `${protocol} 无法连接服务器${host ? `（${host}）` : ''}，请检查服务器地址和网络。`;
  }
  if (/certificate|self-signed|unable to verify|SSL|TLS|handshake/i.test(combined)) {
    return withServerDetail(`${protocol} 加密连接失败。`, detail || message);
  }
  return withServerDetail(
    message === 'Command failed' ? `${protocol} 请求被服务器拒绝。` : message,
    detail,
  );
}

/** Safe diagnostic fields for logs; passwords and auth commands are intentionally omitted. */
export function mailErrorDiagnostic(error: unknown): string {
  const record = recordOf(error);
  return [
    text(record.responseStatus) && `status=${text(record.responseStatus)}`,
    text(record.serverResponseCode) && `server=${text(record.serverResponseCode)}`,
    text(record.code) && `code=${text(record.code)}`,
    serverDetail(error) && `detail=${serverDetail(error)}`,
  ].filter(Boolean).join(' | ');
}
