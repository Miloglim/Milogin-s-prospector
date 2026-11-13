const teams = {
  east: { name: '华东运营组', type: '运营组', leader: '陈诚', members: 18, replies: 24, pending: 3, activity: '刚刚有新回复', people: [['陈诚', '负责人', '在线'], ['林玥', '南美销售组', '7 人'], ['周航', '欧洲销售组', '6 人']] },
  south: { name: '南美销售组', type: '销售团队', leader: '林玥', members: 7, replies: 12, pending: 5, activity: '8 分钟前完成 12 封跟进', people: [['林玥', '负责人', '在线'], ['Ana Costa', '销售成员', '今日活跃'], ['Luis Lima', '销售成员', '今日活跃']] },
  europe: { name: '欧洲销售组', type: '销售团队', leader: '周航', members: 6, replies: 8, pending: 5, activity: '24 分钟前更新报价', people: [['周航', '负责人', '在线'], ['Mia Chen', '销售成员', '1 小时前'], ['Leo Wang', '销售成员', '今日活跃']] },
  direct: { name: '直属销售组', type: '直属团队', leader: '杨岚', members: 5, replies: 6, pending: 2, activity: '1 小时前完成客户跟进', people: [['杨岚', '负责人', '在线'], ['Iris Xu', '销售成员', '今日活跃'], ['Kai Wu', '销售成员', '昨天']] },
  support: { name: '客户支持组', type: '支持团队', leader: '刘睿', members: 4, replies: 2, pending: 1, activity: '退信核对中', people: [['刘睿', '负责人', '在线'], ['Nina Gao', '支持成员', '今日活跃']] }
};

const members = {
  lin: { name: '林玥', initials: 'LY', team: '南美销售组', sent: 38, replies: 12, pending: 5, last: '10:42 收到客户回复', activities: ['完成 12 封跟进', '新增 3 条回复', '2 条线索等待继续推进'] },
  zhou: { name: '周航', initials: 'ZH', team: '欧洲销售组', sent: 31, replies: 8, pending: 5, last: '10:16 更新报价', activities: ['完成欧洲线报价', '1 条回复待处理', '5 条线索超过 3 天未跟进'] },
  yang: { name: '杨岚', initials: 'YL', team: '直属销售组', sent: 27, replies: 6, pending: 2, last: '09:44 完成客户跟进', activities: ['完成 9 封跟进', '2 条回复已处理', '今日暂无逾期线索'] },
  liu: { name: '刘睿', initials: 'LR', team: '客户支持组', sent: 12, replies: 2, pending: 1, last: '08:58 核对退信', activities: ['2 个退信邮箱已暂停', '1 条支持问题处理中', '今日触达量偏低'] }
};

const titles = {
  admin: { title: '团队管理', chip: '管理员视图', meta: '9 个运营组 · 26 个销售团队', action: '新建组织' },
  leader: { title: '团队监控', chip: '主管视图', meta: '南美销售组 · 7 位成员', action: '导出周报' },
  member: { title: '个人工作台', chip: '成员视图', meta: '南美销售组 · 今日行动', action: '刷新工作台' }
};

const roleTabs = {
  admin: [['admin', '团队管理'], ['monitor', '监控'], ['performance', '绩效']],
  leader: [['monitor', '近况'], ['performance', '绩效']],
  member: [['workspace', '工作台']]
};

const toast = document.querySelector('#toast');
const roleChip = document.querySelector('#role-chip');
const pageTitle = document.querySelector('#page-title');
const pageMeta = document.querySelector('#page-meta');
const sectionTabs = document.querySelector('#section-tabs');
const primaryAction = document.querySelector('#primary-action');
const adminInspector = document.querySelector('#admin-inspector');
const leaderInsight = document.querySelector('#leader-insight');

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function renderAdminInspector(teamId) {
  const team = teams[teamId] || teams.east;
  adminInspector.innerHTML = `
    <div class="inspector-title">
      <span class="eyebrow">${team.type} · ${team.activity}</span>
      <h2>${team.name}</h2>
      <p>负责人 ${team.leader} · 组织结构与成员权限保持独立</p>
    </div>
    <div class="inspector-section">
      <h3>团队概况</h3>
      <div class="inspector-kpis">
        <div class="inspector-kpi"><strong>${team.members}</strong><span>成员</span></div>
        <div class="inspector-kpi"><strong>${team.replies}</strong><span>本周回复</span></div>
        <div class="inspector-kpi"><strong>${team.pending}</strong><span>待处理</span></div>
      </div>
    </div>
    <div class="inspector-section">
      <h3>关键成员</h3>
      ${team.people.map(([name, role, state]) => `<div class="person-row"><span class="member-avatar">${name.slice(0, 2)}</span><span><strong>${name}</strong><small>${role}</small></span><em>${state}</em></div>`).join('')}
    </div>
    <div class="inspector-section">
      <h3>最近活动</h3>
      <div class="mini-event"><i></i><span>团队成员完成一轮客户跟进，3 条线索进入下一阶段。</span><time>10:42</time></div>
      <div class="mini-event"><i></i><span>新增 2 条客户回复，均已分配到负责人。</span><time>10:16</time></div>
      <div class="mini-event"><i></i><span>组织邀请已发送，等待成员接受。</span><time>昨天</time></div>
    </div>
    <div class="inspector-actions">
      <button class="button secondary" type="button">编辑团队</button>
      <button class="button primary" type="button">邀请成员</button>
    </div>`;
  refreshIcons();
}

function renderLeaderInsight(memberId) {
  const member = members[memberId] || members.lin;
  leaderInsight.innerHTML = `
    <div class="insight-person">
      <span class="member-avatar">${member.initials}</span>
      <div><strong>${member.name}</strong><small>${member.team} · ${member.last}</small></div>
    </div>
    <div class="insight-list">
      <div class="insight-line"><span>今日发出</span><strong>${member.sent}</strong></div>
      <div class="insight-line"><span>收到回复</span><strong>${member.replies}</strong></div>
      <div class="insight-line"><span>待处理线索</span><strong>${member.pending}</strong></div>
      <div class="insight-line"><span>当前状态</span><span class="status ${member.pending > 3 ? 'warn' : 'good'}">${member.pending > 3 ? '需要关注' : '状态正常'}</span></div>
    </div>
    <div class="mini-timeline">
      <h3>最近动作</h3>
      ${member.activities.map((activity, index) => `<div class="mini-event"><i></i><span>${activity}</span><time>${index === 0 ? '刚刚' : `${index * 8 + 4} 分钟前`}</time></div>`).join('')}
    </div>`;
  document.querySelector('#member-eyebrow').textContent = `${member.name} · ${member.team}`;
  refreshIcons();
}

function selectTeam(teamId) {
  document.querySelectorAll('[data-team]').forEach(node => node.classList.toggle('is-selected', node.dataset.team === teamId));
  renderAdminInspector(teamId);
}

function selectMember(memberId) {
  document.querySelectorAll('[data-member]').forEach(node => node.classList.toggle('is-selected', node.dataset.member === memberId));
  renderLeaderInsight(memberId);
}

function renderTabs(role) {
  sectionTabs.innerHTML = roleTabs[role].map(([section, label], index) => `<button type="button" class="${index === 0 ? 'is-active' : ''}" data-section="${section}">${label}</button>`).join('');
}

function applyRole(role) {
  const meta = titles[role];
  document.querySelectorAll('[data-role]').forEach(button => button.classList.toggle('is-active', button.dataset.role === role));
  document.querySelectorAll('.role-view').forEach(view => view.classList.toggle('is-active', view.dataset.view === role));
  pageTitle.textContent = meta.title;
  roleChip.textContent = meta.chip;
  pageMeta.textContent = meta.meta;
  primaryAction.innerHTML = `${icon(role === 'admin' ? 'plus' : role === 'leader' ? 'download' : 'refresh-cw')}<span>${meta.action}</span>`;
  renderTabs(role);
  refreshIcons();
}

document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => applyRole(button.dataset.role)));
document.querySelectorAll('[data-admin-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-admin-mode]').forEach(item => item.classList.toggle('is-active', item === button));
  document.querySelectorAll('[data-admin-view]').forEach(view => view.classList.toggle('is-active', view.dataset.adminView === button.dataset.adminMode));
}));
document.addEventListener('click', event => {
  const teamButton = event.target.closest('[data-team]');
  if (teamButton) selectTeam(teamButton.dataset.team);
  const memberButton = event.target.closest('[data-member]');
  if (memberButton) selectMember(memberButton.dataset.member);
});
sectionTabs.addEventListener('click', event => {
  const button = event.target.closest('[data-section]');
  if (!button) return;
  sectionTabs.querySelectorAll('button').forEach(item => item.classList.toggle('is-active', item === button));
  if (button.dataset.section === 'monitor') applyRole('leader');
  if (button.dataset.section === 'performance') showToast('绩效视图沿用同一标题层和指标带，当前 demo 聚焦工作区结构。');
  if (button.dataset.section === 'workspace') applyRole('member');
});
primaryAction.addEventListener('click', () => showToast(primaryAction.textContent.trim() === '新建组织' ? '已打开新建组织流程' : '演示状态已刷新'));
document.querySelector('#global-search').addEventListener('input', event => {
  const keyword = event.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-team]').forEach(node => {
    const team = teams[node.dataset.team];
    const match = !keyword || `${team.name} ${team.leader}`.toLowerCase().includes(keyword);
    node.hidden = !match;
  });
  document.querySelectorAll('[data-member]').forEach(node => {
    const member = members[node.dataset.member];
    const match = !keyword || `${member.name} ${member.team}`.toLowerCase().includes(keyword);
    node.hidden = !match;
  });
});

renderAdminInspector('east');
renderLeaderInsight('lin');
applyRole('admin');
