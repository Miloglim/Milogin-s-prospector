import {createCenterCompanyPort} from './centerCompanyPort';
import { contactFollowupAge } from '../../../shared/crm';
import { useMemo } from 'react';
import { CrmPipeline, type PipelineDataPort, type PipelineContact } from '../crm/CrmPipeline';
import { CompanyPage } from '../companies/CompanyPage';
import { CRM_STAGES } from '../../components/ContactDetail';
import { type CenterContactPort } from './centerContactPort';
import { CenterContactDetail as DetailDrawer } from './CenterContactDetail';
import { useIdentity } from '../../IdentityContext';

/** Data adaptation only: the original board and company components own presentation. */
export function CenterContactViews({ port, view }: { port: CenterContactPort; view: 'board' | 'company' }) {
  const offline = useIdentity().status === 'offline';
  const boardPort = useMemo<PipelineDataPort>(() => ({
    key: port.key,
    async list() {
      const result = await port.readAll({ followupOnly: true });
      if (!result.success) return { success: false, error: result.error };
      const config = await window.api.invoke('system:getConfig') as { success: boolean; data?: { crm?: { silentOverdueDays?: number; warnDays?: number } } };
      const rows = result.data ?? [];
      return { success: true, data: CRM_STAGES.map(stage => ({ ...stage, contacts: rows.filter(row => (row.relationshipStage && row.relationshipStage !== 'cold' ? row.relationshipStage : 'reaching') === stage.key).map(row => ({ ...row, id: row.contactId, email: row.email ?? '', stage: stage.key, sendStage: row.stage, reminderAt: null, ...contactFollowupAge(row.lastFollowupAt ?? null, Date.now(), config.success ? config.data?.crm : undefined), lastFollowupAt: row.lastFollowupAt ?? null, lastFollowupNote: row.lastFollowupNote ?? null, assignee: row.ownerName, stageChangedAt: null }) as PipelineContact) })) };
    },
    renderDetail(contact, close) {
      const customerId = contact?.customerId ?? (contact ? port.records.get(contact.id)?.customerId : undefined);
      return <DetailDrawer variant="board" key={contact?.id ?? 'closed'} reference={contact && customerId ? { contactId: contact.id, customerId } : null} onClose={close} />;
    },
  }), [port]);
  const companyPort = useMemo(() => createCenterCompanyPort(port,offline),[port,offline]);
  return view === 'board' ? <CrmPipeline dataPort={boardPort} /> : <CompanyPage dataPort={companyPort} />;
}
