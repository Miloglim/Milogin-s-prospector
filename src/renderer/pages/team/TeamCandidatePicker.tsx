import { useDeferredValue, useState } from 'react';
import { Search } from 'lucide-react';
import { useTeamCandidates } from './team-data';

function candidateScore(row: { displayName: string; email?: string | null }, search: string): number {
  const query = search.toLocaleLowerCase('zh-CN');
  const values = [row.displayName, row.email ?? ''].map(value => value.toLocaleLowerCase('zh-CN'));
  if (values.some(value => value === query)) return 0;
  if (values.some(value => value.startsWith(query))) return 1;
  if (values.some(value => value.includes(query))) return 2;
  return 3;
}

export function rankTeamCandidates<T extends { displayName: string; email?: string | null }>(rows: readonly T[], search: string): T[] {
  const query = search.trim();
  if (!query) return [];
  return [...rows].sort((left, right) => candidateScore(left, query) - candidateScore(right, query) || left.displayName.localeCompare(right.displayName, 'zh-CN'));
}

export function TeamCandidatePicker({ selected, onChange, enabled, purpose = 'invite' }: { selected: readonly string[]; onChange: (ids: string[]) => void; enabled: boolean; purpose?: 'invite' | 'create' }) {
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const query = useTeamCandidates(deferred, enabled && deferred.length > 0, 'member', 'sales_team', purpose);
  const result = query.data;
  const rows = result?.ok ? rankTeamCandidates(result.data.items, deferred) : [];
  const toggle = (userId: string) => onChange(selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId]);

  return <div className="team-candidate-picker">
    <label className="team-field-search"><Search aria-hidden="true" /><input value={search} maxLength={500} onChange={event => setSearch(event.target.value)} placeholder="输入姓名或邮箱" /></label>
    {!enabled ? <div className="team-inline-state">联网后可选择成员</div>
      : deferred.length === 0 ? null
        : result && !result.ok ? <div className="team-inline-state is-error">{result.error.message}</div>
          : query.isLoading ? <div className="team-inline-state">正在读取中心账号</div>
            : rows.length === 0 ? <div className="team-inline-state">没有匹配账号</div>
              : <div className="team-candidate-list">{rows.map(row => <label key={row.userId} className="team-candidate-row"><input type="checkbox" checked={selected.includes(row.userId)} onChange={() => toggle(row.userId)} /><span><strong>{row.displayName}</strong><small>{row.email || '中心账号'}</small></span></label>)}</div>}
    <div className="team-candidate-count">已选 {selected.length} 人</div>
  </div>;
}
