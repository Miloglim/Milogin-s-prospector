import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Drawer, Radio, Spin, Tag } from 'antd';
import { LinkOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  ONLINE_CHANNELS,
  type LeadIngressAction,
  type LeadIngressCandidateDTO,
  type LeadIngressDecisionDTO,
  type LeadIngressDecisionQuery,
  type LeadIngressResolutionCommand,
  type LeadIngressResolutionReceipt,
  type Result,
} from '../../../shared/online-crm';
import { invalidateDomain } from '../../lib/cacheDeps';
import { centerInvoke } from './centerContactPort';

export interface LeadIngressConflictTarget {
  source: LeadIngressDecisionQuery['source'];
  idempotencyKey: string;
  rowLabel?: string;
}
export interface LeadIngressConflictNotice extends LeadIngressConflictTarget {
  message: string;
}

type Invoke = <T>(channel: string, input?: unknown) => Promise<Result<T>>;
type Props = {
  target: LeadIngressConflictTarget | null;
  invoke?: Invoke;
  onClose: () => void;
  onResolved: (receipt: LeadIngressResolutionReceipt) => void | Promise<void>;
};

const ACTION_META: Record<LeadIngressAction, { label: string; icon: ReactNode }> = {
  attach_company: { label: '关联现有公司', icon: <LinkOutlined /> },
  create_new: { label: '作为新记录', icon: <PlusOutlined /> },
  restore: { label: '恢复已删除联系人', icon: <UndoOutlined /> },
};

const LEVEL_LABELS: Record<LeadIngressCandidateDTO['level'], string> = {
  exact_email: '邮箱相同',
  exact_domain: '域名相同',
  exact_company: '公司同名',
  strong_company: '公司高度相似',
  weak_company: '公司可能相似',
  none: '无冲突',
};

/** Resolution keys stay stable for an unchanged decision until the center confirms a terminal outcome. */
export function LeadIngressConflictDrawer({ target, invoke = centerInvoke, onClose, onResolved }: Props) {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<LeadIngressDecisionDTO | null>(null);
  const [action, setAction] = useState<LeadIngressAction>();
  const [candidateCompanyId, setCandidateCompanyId] = useState<number>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const retry = useRef<{ signature: string; command: LeadIngressResolutionCommand } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    retry.current = null;
    setDecision(null);
    setAction(undefined);
    setCandidateCompanyId(undefined);
    setError('');
    if (!target) return;
    setLoading(true);
    void invoke<LeadIngressDecisionDTO>(ONLINE_CHANNELS.LEAD_INGRESS_DECISION, {
      source: target.source,
      idempotencyKey: target.idempotencyKey,
    } satisfies LeadIngressDecisionQuery).then(result => {
      if (generation.current !== current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDecision(result.data);
      if (result.data.suggestedActions.length === 1) setAction(result.data.suggestedActions[0]);
      if (result.data.suggestedActions.includes('attach_company')) setCandidateCompanyId(result.data.candidates[0]?.companyId);
    }).catch((reason: unknown) => {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : '冲突记录读取失败');
    }).finally(() => {
      if (generation.current === current) setLoading(false);
    });
    return () => { generation.current++; };
  }, [invoke, target?.source, target?.idempotencyKey]);

  const close = () => {
    if (!resolving) onClose();
  };

  async function resolve() {
    if (!decision || !action || resolving) return;
    if (action === 'attach_company' && candidateCompanyId === undefined) {
      setError('请选择要关联的公司');
      return;
    }
    const signature = JSON.stringify([decision.decisionId, decision.version, action, candidateCompanyId ?? null]);
    if (retry.current?.signature !== signature) {
      retry.current = {
        signature,
        command: {
          decisionId: decision.decisionId,
          action,
          expectedVersion: decision.version,
          idempotencyKey: crypto.randomUUID(),
        },
      };
    }
    setResolving(true);
    setError('');
    try {
      const result = await invoke<LeadIngressResolutionReceipt>(ONLINE_CHANNELS.LEAD_INGRESS_RESOLVE, retry.current.command);
      if (!result.ok) {
        if (result.error.code !== 'UNAVAILABLE') retry.current = null;
        setError(result.error.message);
        return;
      }
      retry.current = null;
      try {
        await Promise.all([
          invalidateDomain(qc, 'contacts', 'companies'),
          qc.invalidateQueries({ queryKey: ['center-contact-groups'] }),
          qc.invalidateQueries({ queryKey: ['center-import-batches'] }),
          qc.invalidateQueries({ queryKey: ['center-batches'] }),
        ]);
        await onResolved(result.data);
      } catch (reason) {
        // The center already committed; do not invite a second resolution with a new key.
        setError(`冲突已处理，但页面未能继续刷新：${reason instanceof Error ? reason.message : '请重新打开当前页面'}`);
      }
    } catch (reason) {
      // Unknown transport outcome: retain the exact key and expected version.
      setError(reason instanceof Error ? reason.message : '处理结果未知，请重试');
    } finally {
      setResolving(false);
    }
  }

  const canResolve = decision?.status === 'needs_resolution';
  const actions = decision?.suggestedActions.filter((item, index, all) => all.indexOf(item) === index) ?? [];
  return <Drawer
    rootClassName="app-drawer-below-titlebar"
    className="lead-ingress-conflict"
    title="处理重复线索"
    open={!!target}
    onClose={close}
    width="min(520px, calc(100vw - 16px))"
    destroyOnClose
    footer={canResolve ? <div className="lead-ingress-conflict-footer">
      <Button onClick={close}>取消</Button>
      <Button type="primary" loading={resolving} disabled={!action || (action === 'attach_company' && candidateCompanyId === undefined)} onClick={() => void resolve()}>
        确认处理
      </Button>
    </div> : null}
  >
    <div className="lead-ingress-conflict-body">
      {target?.rowLabel && <div className="lead-ingress-conflict-row">{target.rowLabel}</div>}
      {loading && <div className="lead-ingress-conflict-loading"><Spin size="small" /></div>}
      {error && <Alert type="error" showIcon message={error} />}
      {decision && <>
        <div className="lead-ingress-conflict-summary">
          <Tag>{LEVEL_LABELS[decision.level] ?? decision.level}</Tag>
          <span>{decision.message}</span>
        </div>

        {canResolve && actions.length > 0 && <Radio.Group
          className="lead-ingress-action-group"
          value={action}
          onChange={event => {
            const next = event.target.value as LeadIngressAction;
            setAction(next);
            setError('');
            if (next === 'attach_company' && candidateCompanyId === undefined) setCandidateCompanyId(decision.candidates[0]?.companyId);
          }}
        >
          {actions.map(item => <Radio.Button value={item} key={item}>{ACTION_META[item].icon}<span>{ACTION_META[item].label}</span></Radio.Button>)}
        </Radio.Group>}

        {action === 'attach_company' && <section className="lead-ingress-candidate-section">
          <div className="lead-ingress-section-title">现有公司</div>
          <Radio.Group value={candidateCompanyId} onChange={event => setCandidateCompanyId(Number(event.target.value))} className="lead-ingress-candidates">
            {decision.candidates.map(candidate => <Radio value={candidate.companyId} key={`${candidate.companyId}:${candidate.contactId ?? ''}`}>
              <span className="lead-ingress-candidate-copy">
                <strong>{candidate.label}</strong>
                <small>{[candidate.domain, candidate.country].filter(Boolean).join(' · ') || '资料有限'}</small>
              </span>
              <span className="lead-ingress-candidate-score">
                <Tag>{LEVEL_LABELS[candidate.level] ?? candidate.level}</Tag>
                <small>{Math.round(candidate.score * 100)}%</small>
              </span>
            </Radio>)}
          </Radio.Group>
        </section>}

        {decision.status !== 'needs_resolution' && <Alert
          type={decision.status === 'restricted_conflict' ? 'warning' : 'info'}
          showIcon
          message={decision.message || '当前记录不能重复创建'}
        />}
      </>}
    </div>
  </Drawer>;
}

export function conflictTargetForAttempt(
  source: LeadIngressDecisionQuery['source'],
  idempotencyKey: string,
  index: number,
  rowLabel?: string,
): LeadIngressConflictTarget {
  return { source, idempotencyKey: `${idempotencyKey.slice(0, 120)}:${index}`, ...(rowLabel ? { rowLabel } : {}) };
}
