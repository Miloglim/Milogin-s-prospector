import { AccountProfilePanel } from '../../components/AccountProfilePanel';
import { useIdentity } from '../../IdentityContext';

/** Account and settings use the same main-content shell and session authority. */
export function AccountProfilePage() {
  const { identity } = useIdentity();
  if (!identity) return null;
  return <div className="mx-auto w-full max-w-6xl">
    <AccountProfilePanel identity={identity} />
  </div>;
}
