import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Spin, Statistic, Tag, Typography, theme } from 'antd';
import type { DashboardState, OperationsSummary } from '../server/core/management-dashboard';
import { api, ApiError, type Identity } from './api';

const stateText: Record<DashboardState, string> = { healthy: '正常', attention: '需关注', offline: '异常', not_connected: '未接入' };
const stateColor: Record<DashboardState, string> = { healthy: 'success', attention: 'warning', offline: 'error', not_connected: 'default' };
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const formatDuration = (seconds: number) => {
  const days = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY));
  const hours = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) % HOURS_PER_DAY;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  return [days ? `${days}天` : '', hours ? `${hours}小时` : '', `${minutes}分钟`].filter(Boolean).join(' ');
};

export function OperationsManagement({ identity }: { identity: Identity }) {
  const { token } = theme.useToken();
  const style = { '--dashboard-text': token.colorText, '--dashboard-muted': token.colorTextSecondary, '--dashboard-border': token.colorBorderSecondary, '--dashboard-accent': token.colorPrimary, '--dashboard-tint': token.colorFillSecondary } as CSSProperties;
  const [snapshot, setSnapshot] = useState<OperationsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const version = useRef(0);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    const requestVersion = ++version.current;
    const current = () => mounted.current && requestVersion === version.current;
    setLoading(true); setError('');
    try {
      const result = await api.operations();
      if (current()) setSnapshot(result);
    } catch (cause) {
      if (current()) {
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setSnapshot(null);
        setError(cause instanceof Error ? cause.message : '系统运行状态读取失败');
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    setSnapshot(null);
    void load();
    return () => { mounted.current = false; version.current++; };
  }, [identity.userId, load]);

  return <section className="product-dashboard operations-dashboard" style={style} aria-label="系统运行">
    <div className="dashboard-heading">
      <div><Typography.Title level={2}>系统运行</Typography.Title><Typography.Text type="secondary">服务、数据库与服务器容量</Typography.Text></div>
      <div className="dashboard-heading-actions">{snapshot && <Typography.Text type="secondary">检查于 {formatTime(snapshot.generatedAt)}</Typography.Text>}<Button loading={loading} onClick={() => void load()}>刷新</Button></div>
    </div>
    {loading && !snapshot ? <div className="dashboard-loading"><Spin /><Typography.Text>正在读取系统状态</Typography.Text></div>
      : error && !snapshot ? <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>重试</Button>} />
      : !snapshot ? <Empty description="暂无系统运行数据" /> : <>
        {error && <Alert type="warning" showIcon message={`刷新失败，当前显示上次数据：${error}`} />}
        <Row gutter={[12, 12]} className="dashboard-stats operations-check-grid">
          {snapshot.checks.map(check => <Col xs={24} md={12} xl={8} key={check.id}>
            <Card className="operations-check-card">
              <div className="operations-check-head"><Typography.Text strong>{check.label}</Typography.Text><Tag color={stateColor[check.state]}>{stateText[check.state]}</Tag></div>
              <Statistic title={check.valueLabel} value={check.value} />
              <Typography.Paragraph type="secondary" className="operations-check-detail">{check.detail}</Typography.Paragraph>
            </Card>
          </Col>)}
        </Row>
        <div className="dashboard-grid">
          <Card title="版本与实例">
            <Descriptions size="small" column={1} items={[
              { key: 'version', label: '中心版本', children: `v${snapshot.version}` },
              { key: 'uptime', label: '运行时长', children: formatDuration(snapshot.uptime_seconds) },
              { key: 'checked', label: '最近检查', children: formatTime(snapshot.generatedAt) },
            ]} />
          </Card>
          <Card title="检查汇总">
            <Row gutter={[12, 12]}>
              <Col span={12}><Statistic title="正常" value={snapshot.checks.filter(check => check.state === 'healthy').length} suffix={`/ ${snapshot.checks.length}`} /></Col>
              <Col span={12}><Statistic title="需处理" value={snapshot.checks.filter(check => check.state !== 'healthy').length} valueStyle={{ color: snapshot.checks.some(check => check.state !== 'healthy') ? '#ad6b2e' : undefined }} /></Col>
            </Row>
          </Card>
        </div>
      </>}
  </section>;
}
