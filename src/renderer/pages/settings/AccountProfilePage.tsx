import { AccountProfilePanel } from '../../components/AccountProfilePanel';
import { useIdentity } from '../../IdentityContext';
import { useQuery } from '@tanstack/react-query';
import { ONLINE_CHANNELS, type AccountProfile, type Result } from '../../../shared/online-crm';

/** Account and settings use the same main-content shell and session authority. */
export function AccountProfilePage() {
  const { identity, baseUrl } = useIdentity();
  const profile = useQuery({
    queryKey: ['online-account-profile', baseUrl, identity?.userId],
    enabled: !!identity,
    queryFn: () => window.api.invoke(ONLINE_CHANNELS.ACCOUNT_PROFILE) as Promise<Result<AccountProfile>>,
    staleTime: 30000,
  });
  if (!identity) return null;
  const shared = profile.data?.ok ? profile.data.data : undefined;
  const extras = shared?.userId === identity.userId ? {
    userId: shared.userId,
    displayName: shared.displayName,
    avatarId: shared.avatarId,
    growth: shared.growth ? {
      level: shared.growth.level,
      totalXp: shared.growth.totalXp,
      levelProgress: shared.growth.levelProgress,
      levelCost: shared.growth.levelCost,
    } : undefined,
  } : undefined;
  return <div className="mx-auto w-full max-w-6xl">
    <AccountProfilePanel identity={identity} extras={extras} />
  </div>;
}
