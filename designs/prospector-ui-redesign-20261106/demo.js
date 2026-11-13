const icon = () => window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });

function initTeamDemo() {
  const log = document.querySelector("#team-chat-log");
  const input = document.querySelector("#team-message-input");
  const send = document.querySelector("#team-send-button");
  if (!log || !input || !send) return;

  document.querySelectorAll(".team-member").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".team-member").forEach((item) => item.classList.remove("is-selected"));
      button.classList.add("is-selected");
      const name = button.querySelector("strong")?.textContent || "成员";
      const initials = button.querySelector(".avatar")?.textContent || name.slice(0, 2);
      const header = document.querySelector(".chat-member-head");
      if (header) {
        header.querySelector(".avatar").textContent = initials;
        header.querySelector("strong").textContent = name;
        header.querySelector("small").textContent = `${button.querySelector("small")?.textContent || ""}`;
      }
      const overviewTitle = document.querySelector(".team-overview .panel-heading h2");
      if (overviewTitle) overviewTitle.textContent = name;
    });
  });

  document.querySelectorAll(".request-rate-action").forEach((button) => {
    button.addEventListener("click", () => {
      const approved = button.dataset.action === "approve";
      const card = document.querySelector("#rate-review-card");
      const status = card?.querySelector("[data-rate-status]");
      if (!card || !status) return;
      status.className = `status-pill ${approved ? "good" : "danger"}`;
      status.textContent = approved ? "主管已确认" : "主管已驳回";
      card.querySelectorAll(".request-rate-action").forEach((item) => { item.disabled = true; item.style.opacity = ".45"; });
    });
  });

  const addMessage = () => {
    const text = input.value.trim();
    if (!text) return;
    const wrapper = document.createElement("div");
    wrapper.className = "message is-mine";
    wrapper.innerHTML = `<div class="message-meta"><time>刚刚</time><span>我</span></div><div class="bubble"></div>`;
    wrapper.querySelector(".bubble").textContent = text;
    log.append(wrapper);
    input.value = "";
    log.scrollTop = log.scrollHeight;
  };
  send.addEventListener("click", addMessage);
  input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") addMessage();
  });
}

const mailDetails = {
  santos: { subject: "Re: Santos 2×40HQ rate request", sender: "Ana Lima · Santos Logistics", email: "ana@santos.example", label: "询价", cls: "quote", body: "客户确认 Ningbo → Santos 2×40HQ 报价 USD 2,480/柜，要求今天 16:00 前确认舱位。", original: "Ningbo → Santos · 2×40HQ · preferred ETD 18 Nov.", match: "Santos Logistics · Brazil · 重点客户" },
  blue: { subject: "Quote confirmation · Ningbo → Jebel Ali", sender: "Mia Chen · Blue Ocean Trading", email: "mia@blueocean.example", label: "订单", cls: "order", body: "客户要求保留 2×40HQ 舱位，并在周五前回复最终船期。", original: "Ningbo → Jebel Ali · 2×40HQ · preferred ETD 22 Nov.", match: "Blue Ocean Trading · UAE · 新客户" },
  north: { subject: "Delivery Status Notification (Failure)", sender: "Mail Delivery System", email: "mailer-daemon@local", label: "退信", cls: "complaint", body: "buyer@northport.example 邮箱不存在，系统已暂停该联系人自动开发。", original: "Original recipient: buyer@northport.example", match: "North Port GmbH · Germany · 需要核对邮箱" },
  pacific: { subject: "Ningbo → Los Angeles weekly rate", sender: "发给 Pacific Foods Ltd.", email: "sales@pacific.example", label: "报价", cls: "quote", body: "报价发送后 3 天未收到回复，建议今天补充跟进。", original: "Ningbo → Los Angeles · weekly sailing · valid this week.", match: "Pacific Foods Ltd. · United States · 正常跟进" },
  auto: { subject: "Automatic reply: Holiday schedule", sender: "Auto Reply · Orchid Freight", email: "auto@orchid.example", label: "自动回复", cls: "normal", body: "对方处于休假状态，预计下周恢复。无需立即重复发送。", original: "Automatic reply from Orchid Freight.", match: "Orchid Freight · Netherlands · 自动回复" },
  unmatched: { subject: "New enquiry from website", sender: "hello@seabridge.example", email: "hello@seabridge.example", label: "未匹配", cls: "normal", body: "发件人尚未匹配联系人，可能属于新客户线索。", original: "Website enquiry · no existing contact match.", match: "未匹配发件人 · 可添加为联系人或新客户" },
};

function initInboxDemo() {
  const rows = [...document.querySelectorAll(".mail-row")];
  if (!rows.length) return;

  const setActiveFilter = (filter) => {
    document.querySelectorAll(".sidebar-item").forEach((item) => item.classList.toggle("is-active", item.dataset.filter === filter));
  };

  const matchesFilter = (row, filter) => {
    if (filter === "all" || !filter) return true;
    if (filter === "unread") return row.dataset.unread === "1";
    if (filter === "today" || filter === "overdue") return row.dataset.task === filter;
    if (filter === "urgent" || filter === "important" || filter === "normal") return row.dataset.priority === filter;
    return row.dataset.kind === filter;
  };

  document.querySelectorAll(".sidebar-item[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      setActiveFilter(filter);
      rows.forEach((row) => { row.hidden = !matchesFilter(row, filter); });
      const first = rows.find((row) => !row.hidden);
      if (first) first.click();
    });
  });

  const updateDetail = (key) => {
    const detail = mailDetails[key];
    if (!detail) return;
    const subject = document.querySelector("#mail-detail-subject");
    const sender = document.querySelector("#mail-detail-sender");
    const senderMeta = document.querySelector("#mail-detail-sender-meta");
    const label = document.querySelector("#mail-detail-label");
    const body = document.querySelector("#mail-detail-body");
    if (subject) subject.textContent = detail.subject;
    if (sender) sender.textContent = detail.sender;
    if (senderMeta) senderMeta.textContent = `${detail.email} · 发给我`;
    if (label) { label.textContent = detail.label; label.className = `mini-label ${detail.cls}`; }
    if (body) {
      body.querySelectorAll("p").forEach((node, index) => { node.textContent = index === 0 ? detail.body : ""; node.hidden = index > 0; });
      const match = body.querySelector(".matched-card strong");
      const matchMeta = body.querySelector(".matched-card small");
      const quote = body.querySelector("blockquote");
      if (match) match.textContent = detail.match.split(" · ")[0];
      if (matchMeta) matchMeta.textContent = detail.match.split(" · ").slice(1).join(" · ");
      if (quote) quote.textContent = detail.original;
    }
  };

  rows.forEach((row) => {
    row.addEventListener("click", () => {
      rows.forEach((item) => item.classList.remove("is-selected"));
      row.classList.add("is-selected");
      updateDetail(row.dataset.mail);
    });
  });

  const globalSearch = document.querySelector("#mail-global-search");
  globalSearch?.addEventListener("input", () => {
    const keyword = globalSearch.value.trim().toLowerCase();
    rows.forEach((row) => { row.hidden = !!keyword && !row.textContent.toLowerCase().includes(keyword); });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initTeamDemo();
  initInboxDemo();
  icon();
});
