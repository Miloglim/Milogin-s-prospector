export interface SignatureFields { title?: string; company?: string; phone?: string }
const SIGNATURE_MAX_LINES = 12;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const QUOTE_HEADER_LOOKAHEAD = 8;
const SIGNOFF = /^(?:best(?: regards| wishes)?|kind regards|regards|sincerely|cheers|祝好|此致|tks\s*&\s*b\.?rgds\.?|thanks\s*&\s*regards)(?:\s*[\/&]\s*(?:saludos cordiales|atenciosamente|thank you))*[,!。\s]*(.*)$/i;
const TITLE = /^(?:[\p{Script=Han}]+\s+)?(?:(?:sales|operations?|business development|commercial|account|export|import|branch|general|financial)\s+(?:manager|director|executive|coordinator|supervisor)|(?:overseas\s+)?content specialist|(?:managing\s+)?director|CEO|COO|GM(?:\s+[\p{Script=Han}]+)?|总经理|销售经理)$/iu;

/** 本地化引用头也必须截断；宁可漏填，不能从历史另一人的签名取值。 */
function currentMailLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map(s => s.normalize("NFKC").trim());
  const boundary = lines.findIndex((line, index) => {
    if (/^(?:>|On .{0,200}wrote:|From:|发件人:|[-_]{3,}\s*(?:Original|Forwarded|原始|转发))/i.test(line)) return true;
    if (!/^(?:De|Von|Da|Sender)\s*:/i.test(line)) return false;
    const headers = lines.slice(index, index + QUOTE_HEADER_LOOKAHEAD).join("\n");
    return /@|(?:Enviad[ao](?:\s+em|\s+el)?|Sent|Date|Gesendet|Inviato|Para|To|Assunto|Asunto|Subject)\s*:/i.test(headers);
  });
  return boundary < 0 ? lines : lines.slice(0, boundary);
}

/** 只读当前邮件的签名；引用/转发和含多个候选的字段不猜测。 */
export function extractSignature(text: string): SignatureFields {
  const lines = currentMailLines(text);
  const marker = lines.findIndex(s => {
    const match = s.replace(/^\*+/, "").match(SIGNOFF);
    return !!match && (!match[1] || match[1].includes("|"));
  });
  if (marker < 0) return {};
  const inline = lines[marker]!.replace(/^\*+/, "").match(SIGNOFF)?.[1] || "";
  const tail = [inline, ...lines.slice(marker + 1)].filter(Boolean).slice(0, SIGNATURE_MAX_LINES);
  const unique = (values: string[]) => { const all = [...new Set(values)]; return all.length === 1 ? all[0] : undefined; };
  const titles = tail.map(s => s.includes("|") ? s.slice(s.lastIndexOf("|") + 1).trim() : s).filter(s => TITLE.test(s));
  const company = tail.map(s => s.match(/^(?:company|公司)\s*[:：]\s*(.{2,100})$/i)?.[1]
    ?? (/^[\p{L}\p{N} &.,'’()-]{2,100}(?:\b(?:Logistics|Forwarding|Freight|Shipping|Ltd\.?|Limited|Inc\.?|Corp\.?|Corporation|GmbH|LLC)|有限公司)$/iu.test(s) ? s : undefined))
    .filter((s): s is string => !!s);
  const phones = tail.map(s => s.match(/^(?:tel(?:ephone)?|phone|mobile|cell|电话|手机)(?:\s*[\/&]\s*(?:mobile|wechat|whatsapp|cell|phone))*\s*[:.]?\s*(\+?[\d ()-]+)\s*$/i)?.[1]?.trim())
    .filter((s): s is string => !!s && s.replace(/\D/g, "").length >= PHONE_MIN_DIGITS && s.replace(/\D/g, "").length <= PHONE_MAX_DIGITS);
  const phoneByDigits = new Map(phones.map(s => [s.replace(/\D/g, ""), s]));
  return { title: unique(titles), company: unique(company), phone: phoneByDigits.size === 1 ? [...phoneByDigits.values()][0] : undefined };
}
