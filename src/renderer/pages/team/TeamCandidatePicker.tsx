import { useDeferredValue, useState } from 'react';
import { Search } from 'lucide-react';
import { useTeamCandidates } from './team-data';

export function TeamCandidatePicker({ selected, onChange, enabled }: { selected: readonly string[]; onChange: (ids: string[]) => void; enabled: boolean }) {
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const query = useTeamCandidates(deferred, enabled);
  const result = query.data;
  const rows = result?.ok ? result.data.items : [];
  const toggle = (userId: string) => onChange(selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId]);

  return <div className="team-candidate-picker">
    <label className="team-field-search"><Search aria-hidden="true" /><input value={search} maxLength={500} onChange={event => setSearch(event.target.value)} placeholder="搜索账号" /></label>
    {!enabled ? <div className="team-inline-state">联网后可选择成员</div>
      : result && !result.ok ? <div className="team-inline-state is-error">{result.error.message}</div>
        : query.isLoading ? <div className="team-inline-state">正在读取中心账号</div>
          : rows.length === 0 ? <div className="team-inline-state">暂无可邀请账号</div>
            : <div className="team-candidate-list">{rows.map(row => <label key={row.userId} className="team-candidate-row"><input type="checkbox" checked={selected.includes(row.userId)} onChange={() => toggle(row.userId)} /><span><strong>{row.displayName}</strong><small>{row.email || '中心账号'}</small></span></label>)}</div>}
    <div className="team-candidate-count">已选 {selected.length} 人</div>
  </div>;
}
