import {createCenterCompanyPort} from './centerCompanyPort';
import { CompanyPage } from '../companies/CompanyPage';
import { type CenterContactPort } from './centerContactPort';
import { useIdentity } from '../../IdentityContext';
import { useMemo } from 'react';

/** Data adaptation only: the original company component owns presentation. */
export function CenterContactViews({ port }: { port: CenterContactPort }) {
  const offline = useIdentity().status === 'offline';
  const companyPort = useMemo(() => createCenterCompanyPort(port,offline),[port,offline]);
  return <CompanyPage dataPort={companyPort} />;
}
