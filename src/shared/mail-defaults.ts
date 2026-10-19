/** 默认阿里云邮箱服务器；用户仍可在账号表单中覆盖。 */
export const DEFAULT_MAIL_SERVERS = {
  smtpHost: "smtp.mxhichina.com",
  smtpPort: 465,
  imapHost: "imap.mxhichina.com",
  imapPort: 993,
} as const;
