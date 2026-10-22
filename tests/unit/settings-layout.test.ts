import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const settings = readFileSync(resolve(root, 'src/renderer/pages/settings/SettingsPage.tsx'), 'utf8');
const campaign = readFileSync(resolve(root, 'src/renderer/pages/campaigns/CampaignWizard.tsx'), 'utf8');
const config = readFileSync(resolve(root, 'src/main/config.ts'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');

describe('settings information architecture', () => {
  it('keeps four top-level groups and moves their related sections underneath', () => {
    expect(settings).toContain('{ id: "sec-general", label: "通用" }');
    expect(settings).toContain('{ id: "sec-mail", label: "邮件发送" }');
    expect(settings).toContain('{ id: "sec-advanced", label: "高级" }');
    expect(settings).toContain('{ id: "sec-about", label: "关于" }');
    expect(settings).not.toContain('id="sec-api"');
    expect(settings).not.toContain('id="sec-crm"');
    expect(settings).not.toContain('id="sec-data"');
    expect(settings).toContain('<SettingCard title="API 与服务">');
    expect(settings).toContain('<SettingCard title="客户跟进">');
    expect(settings).toContain('<SettingCard title="数据">');
    expect(settings).toContain('<SettingCard icon="" title="测试模式">');
    expect(settings).toMatch(/id="sec-about"[\s\S]*?<UpdateChecker \/>[\s\S]*?<\/SettingsPanel>/);
  });

  it('uses account rows, a default 800 limit, and removes global send-window/estimate controls', () => {
    expect(settings).toContain('className="settings-account-list"');
    expect(settings).toContain('className="settings-account-row"');
    expect(settings).not.toContain('accountColumns');
    expect(settings).toContain('config?.sendQuota?.dailyLimit ?? 800');
    expect(settings).not.toContain('发送预估');
    expect(settings).toContain('这是邮箱服务商提供的密码或授权码，不是中心登录密码。');
    expect(settings).not.toContain('label="开始时段"');
    expect(settings).not.toContain('label="结束时段"');
    expect(config).toContain('sendQuota: { dailyLimit: 800, firstSendAt: null, sentToday: 0 }');
  });

  it('keeps send windows per campaign and removes the task daily cap input', () => {
    expect(campaign).toContain('发送时段（仅本任务，不勾选 = 不限时段）');
    expect(campaign).toContain('留空自动生成');
    expect(campaign).not.toContain('任务名（必填）');
    expect(campaign).not.toContain('任务名必填');
    expect(campaign).not.toContain('dailyCap');
    expect(campaign).not.toContain('单日上限');
    expect(campaign).not.toContain('单日放行上限');
  });

  it('hides only the settings-page scrollbar while retaining the dot rail', () => {
    expect(css).toContain('body.settings-route-active .app-route-content::-webkit-scrollbar');
    expect(settings).toContain('className="settings-rail hidden lg:block"');
    expect(settings).toContain('settings-rail-dot');
  });
});
