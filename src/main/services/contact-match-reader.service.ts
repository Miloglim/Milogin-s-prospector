import { CENTER_CONTACT_LIMITS, type CenterContact, type CenterContactPage, type CenterContactQuery } from '../../../server/core/center-contacts';
import { failure, success, type Result } from '../../../server/core/crm';

const MAX_MATCH_SCAN_PAGES = 1000;

/** Reads the complete authorized contact set for inbox matching without treating an unavailable cache as an empty result. */
export async function readAllCenterContactsForMatch(
  query: (input: CenterContactQuery) => Promise<Result<CenterContactPage>>,
  active: () => boolean,
): Promise<Result<CenterContact[]>> {
  const rows: CenterContact[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;

  for (let page = 0; page < MAX_MATCH_SCAN_PAGES; page++) {
    if (!active()) return failure('UNAUTHORIZED', '账号已切换');
    const result = await query({
      search: '',
      scope: 'all',
      limit: CENTER_CONTACT_LIMITS.pageMax,
      offset: rows.length,
    });
    if (!active()) return failure('UNAUTHORIZED', '账号已切换');
    if (!result.ok) return result;

    expectedTotal ??= result.data.total;
    if (result.data.total !== expectedTotal) return failure('CONFLICT', '联系人总数已变化，请重新匹配');
    for (const row of result.data.items) {
      const key = `${row.customerId}:${row.contactId}`;
      if (seen.has(key)) return failure('CONFLICT', '联系人列表已变化，请重新匹配');
      seen.add(key);
      rows.push(row);
    }
    if (rows.length === expectedTotal) return success(rows);
    if (rows.length > expectedTotal || result.data.items.length === 0) return failure('CONFLICT', '联系人列表已变化，请重新匹配');
  }

  return failure('UNAVAILABLE', '联系人数量超过本轮匹配范围');
}
