import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Drawer, Radio, Spin, Tag } from 'antd';
import { ArrowRightOutlined, LinkOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
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
  incoming?: {
    companyName?: string;
    contactName?: string;
    email?: string;
    country?: string;
  };
}

export interface LeadIngressConflictPolicy {
  action: LeadIngressAction;
  level: LeadIngressDecisionDTO['level'];
}
export type LeadIngressConflictView = LeadIngressConflictTarget & Pick<LeadIngressConflictNotice, 'incoming'>;

type Invoke = <T>(channel: string, input?: unknown) => Promise<Result<T>>;
type Props = {
  target: LeadIngressConflictView | null;
  invoke?: Invoke;
  onClose: () => void;
  onResolved: (receipt: LeadIngressResolutionReceipt, policy?: LeadIngressConflictPolicy) => void | Promise<void>;
};

const ACTION_META: Record<LeadIngressAction, { label: string; description: string; icon: ReactNode }> = {
  attach_company: { label: '并入现有公司', description: '把这条联系人放到下方选中的公司里，不重复建公司', icon: <LinkOutlined /> },
  create_new: { label: '仍然新建公司', description: '确认不是同一家公司，保留为一条独立记录', icon: <PlusOutlined /> },
  restore: { label: '恢复已删除联系人', description: '找回原联系人和历史记录，不再新建', icon: <UndoOutlined /> },
};

const LEVEL_LABELS: Record<LeadIngressCandidateDTO['level'], string> = {
  exact_email: '邮箱相同',
  exact_domain: '域名相同',
  exact_company: '公司同名',
  strong_company: '公司高度相似',
  weak_company: '公司可能相似',
  none: '无冲突',
};

function conflictTitle(level: LeadIngressDecisionDTO['level'] | undefined): string {
  if (level === 'exact_email') return '联系人已经存在';
  if (level === 'exact_domain') return '发现同域名公司';
  if (level === 'exact_company') return '发现同名公司';
  if (level === 'strong_company') return '发现相似公司';
  return '处理重复线索';
}

function conflictExplanation(decision: LeadIngressDecisionDTO): string {
  if (decision.level === 'exact_domain') return '本次导入的邮箱域名与下面这家公司相同，通常说明是同一家公司。核对后可以把联系人直接并入现有公司。';
  if (decision.level === 'exact_company') return '本次导入的公司名与下面这家公司完全一致。请确认国家和公司资料，避免把不同国家的同名公司合并。';
  if (decision.level === 'strong_company') return '本次导入的公司名与下面这家公司很接近，但系统不能确定是不是同一家。请对比名称、国家和域名后再决定。';
  return decision.message;
}

/** Resolution keys stay stable for an unchanged decision until the center confirms a terminal outcome. */
export function LeadIngressConflictDrawer({ target, invoke = centerInvoke, onClose, onResolved }: Props) {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<LeadIngressDecisionDTO | null>(null);
  const [action, setAction] = useState<LeadIngressAction>();
  const [candidateCompanyId, setCandidateCompanyId] = useState<number>();
  const [applyToFollowing, setApplyToFollowing] = useState(false);
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
    setApplyToFollowing(false);
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
      const preferred = result.data.suggestedActions.includes('attach_company') ? 'attach_company' : result.data.suggestedActions.length === 1 ? result.data.suggestedActions[0] : undefined;
      if (preferred) setAction(preferred);
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
        await onResolved(result.data, applyToFollowing ? { action, level: decision.level } : undefined);
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
    title={conflictTitle(decision?.level)}
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
        {target?.incoming && <div className="lead-ingress-compare">
          <div className="lead-ingress-compare-card">
            <span>本次导入</span>
            <strong>{target.incoming.companyName || '未填写公司名'}</strong>
            <small>{[target.incoming.contactName, target.incoming.email, target.incoming.country].filter(Boolean).join(' · ') || '联系人资料有限'}</small>
          </div>
          <ArrowRightOutlined className="lead-ingress-compare-arrow" />
          <div className="lead-ingress-compare-card is-existing">
            <span>系统找到的现有公司</span>
            <strong>{decision.candidates[0]?.label || '未命名公司'}</strong>
            <small>{[decision.candidates[0]?.domain, decision.candidates[0]?.country].filter(Boolean).join(' · ') || '资料有限'}</small>
          </div>
        </div>}
        <div className="lead-ingress-conflict-summary">
          <Tag>{LEVEL_LABELS[decision.level] ?? decision.level}</Tag>
          <span>{conflictExplanation(decision)}</span>
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
          {actions.map(item => <Radio.Button value={item} key={item}><span className="lead-ingress-action-copy">{ACTION_META[item].icon}<strong>{ACTION_META[item].label}</strong><small>{ACTION_META[item].description}</small></span></Radio.Button>)}
        </Radio.Group>}

        {decision.candidates.length > 0 && <section className="lead-ingress-candidate-section">
          <div className="lead-ingress-section-title">现有公司</div>
          <Radio.Group value={candidateCompanyId} onChange={event => { setCandidateCompanyId(Number(event.target.value)); if(action !== 'attach_company') setAction('attach_company'); }} className="lead-ingress-candidates">
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

        {canResolve && actions.length > 0 && <label className="lead-ingress-repeat-policy">
          <Checkbox checked={applyToFollowing} onChange={event => setApplyToFollowing(event.target.checked)}>后续同类冲突也按这次选择处理</Checkbox>
          <small>只对冲突类型相同、且同样允许“{action ? ACTION_META[action].label : '当前选择'}”的记录生效；每条仍使用各自匹配到的公司，不会合并到同一家公司。</small>
        </label>}

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
