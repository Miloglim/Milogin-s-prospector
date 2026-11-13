import { describe, expect, it } from 'vitest';
import { describeMailError, mailErrorDiagnostic } from '../../src/main/core/mail-error';

describe('mail protocol error messages', () => {
  it('turns an IMAP LOGIN rejection into an actionable authorization message', () => {
    const error = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: 'LOGIN failed.',
      response: '3 NO LOGIN failed.',
    });

    expect(describeMailError(error, 'IMAP')).toContain('IMAP 登录失败');
    expect(describeMailError(error, 'IMAP')).toContain('邮箱密码/授权码');
    expect(describeMailError(error, 'IMAP')).toContain('LOGIN failed.');
    expect(mailErrorDiagnostic(error)).toContain('status=NO');
    expect(mailErrorDiagnostic(error)).toContain('detail=LOGIN failed.');
  });

  it('keeps non-auth server responses visible instead of returning Command failed', () => {
    const error = Object.assign(new Error('Command failed'), {
      responseStatus: 'BAD',
      responseText: 'Unsupported search criteria',
    });

    expect(describeMailError(error, 'IMAP')).toBe(
      'IMAP 请求被服务器拒绝。 服务器返回：Unsupported search criteria',
    );
  });

  it('classifies timeout and network errors', () => {
    expect(describeMailError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'SMTP'))
      .toContain('SMTP 连接超时');
    expect(describeMailError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { hostname: 'imap.invalid' }), 'IMAP'))
      .toBe('IMAP 无法连接服务器（imap.invalid），请检查服务器地址和网络。');
  });
});
