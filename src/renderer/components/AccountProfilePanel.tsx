import { Avatar, Card, Descriptions, Progress, Tag, theme } from 'antd';
import type { Identity } from '../../shared/online-crm';

/** Presentation data only. Future center adapters supply these fields; unknown is not zero. */
export interface AccountProfileExtras {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  avatarId?: string;
  growth?: { level: number; totalXp: number; levelProgress: number; levelCost: number };
  badges?: Array<{ id: string; label: string }>;
  preferences?: Array<{ id: string; label: string; value: string }>;
}

const avatarUrls = import.meta.glob('../assets/avatars/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
function avatarUrl(id?: string): string | undefined {
  return id && id !== 'default' ? avatarUrls[`../assets/avatars/${id}.png`] : undefined;
}

export function AccountProfilePanel({ identity, extras }: { identity: Identity; extras?: AccountProfileExtras }) {
  const { token } = theme.useToken();
  const data = extras?.userId === identity.userId ? extras : undefined;
  const displayName = data?.displayName || identity.displayName;
  const growth = data?.growth;
  const progress = growth && growth.levelCost > 0 ? Math.min(100, Math.max(0, growth.levelProgress / growth.levelCost * 100)) : undefined;
  return <div className="account-profile-layout" style={{ color: token.colorText }}>
    <div className="account-profile-main">
      <Card title="基本信息" size="small">
        <Descriptions column={1} colon={false} items={[
          { key: 'name', label: '用户名', children: displayName },
          { key: 'email', label: '登录邮箱', children: identity.email },
        ]} />
      </Card>
      <Card title="个人偏好" size="small">
        {data?.preferences?.length ? <Descriptions column={1} colon={false} items={data.preferences.map(item => ({ key: item.id, label: item.label, children: item.value }))} /> : <div className="account-profile-pending" style={{ color: token.colorTextTertiary }}>—</div>}
      </Card>
      <Card title="账号安全" size="small">
        <Descriptions column={1} colon={false} items={[
          { key: 'login', label: '登录方式', children: '邮箱与密码' },
          { key: 'verified', label: '邮箱验证', children: identity.emailVerified ? '已验证' : '未验证' },
        ]} />
      </Card>
    </div>
    <aside className="account-profile-identity">
      <Card size="small">
        <div className="account-profile-face">
          <Avatar shape="square" size={72} src={data?.avatarUrl ?? avatarUrl(data?.avatarId)} style={{ background: token.colorFillSecondary, color: token.colorText, borderRadius: 20, fontSize: 27 }}>{Array.from(displayName || identity.email)[0]?.toUpperCase()}</Avatar>
          <div className="account-profile-name">{displayName}</div>
        </div>
        <div className="account-profile-growth" style={{ borderColor: token.colorBorderSecondary }}>
          <div className="account-profile-label" style={{ color: token.colorTextSecondary }}>等级与经验</div>
          {growth && progress !== undefined ? <><div className="account-profile-level">Lv. {growth.level}</div><Progress percent={progress} showInfo={false} strokeColor={token.colorPrimary} /><div style={{ color: token.colorTextSecondary, fontSize: 12 }}>{growth.levelProgress} / {growth.levelCost} XP</div></> : <div className="account-profile-pending" style={{ color: token.colorTextTertiary }}>—</div>}
          <div className="account-profile-label" style={{ color: token.colorTextSecondary }}>徽章</div>
          {data?.badges?.length ? data.badges.map(badge => <Tag key={badge.id}>{badge.label}</Tag>) : <span style={{ color: token.colorTextTertiary }}>—</span>}
        </div>
      </Card>
    </aside>
  </div>;
}
