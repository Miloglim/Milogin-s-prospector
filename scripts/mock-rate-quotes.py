"""rate_quotes 空值 mock 填充（只填空，不覆盖已有值）。
原则：
- 只补"读侧消费"的字段：carrier / container / container_raw / ocean_usd /
  validity_raw / valid_from / valid_to / free_days / shortfall_fee / note / etd
- 不补：image_name（空→UI 无图降级，编造会破图）、status / message_text（读侧不消费）
- 填充基准来自同表现有非空分布（lane 众数 carrier、lane+carrier 众数 container、
  lane+carrier+container 中位数 ocean_usd、源端文本风格 validity_raw/etd）
幂等：只更新 IS NULL / '' 的行。跑前已备份 prospector-2026-09-14-pre-mock.db。
"""
import sqlite3, re, statistics
from collections import Counter, defaultdict

DB = "E:/Agents Basement/projects/NEW/data/prospector.db"
con = sqlite3.connect(DB)
cur = con.cursor()

def rows(sql, *args):
    cur.execute(sql, args)
    return cur.fetchall()

stats_log = []

def update(sql, *args):
    cur.execute(sql, args)
    stats_log.append((sql[:60], cur.rowcount))

# ── 1. carrier：lane 众数 ──────────────────────────────────────────────
lane_carrier = defaultdict(Counter)
for lane, carrier in rows("SELECT lane, carrier FROM rate_quotes WHERE carrier IS NOT NULL AND carrier<>'' AND lane IS NOT NULL"):
    lane_carrier[lane][carrier] += 1
lane_top = {l: c.most_common(1)[0][0] for l, c in lane_carrier.items()}
for lane, top in lane_top.items():
    update("UPDATE rate_quotes SET carrier=? WHERE (carrier IS NULL OR carrier='') AND lane=?", top, lane)
# 兜底（lane 也空）
update("UPDATE rate_quotes SET carrier='MSC' WHERE (carrier IS NULL OR carrier='')")

# ── 2. container / container_raw：lane+carrier 众数 ────────────────────
cc_container = defaultdict(Counter)
for lane, carrier, c in rows("SELECT lane, carrier, container FROM rate_quotes WHERE container IS NOT NULL AND container<>''"):
    cc_container[(lane, carrier)][c] += 1
for (lane, carrier), c in cc_container.items():
    top = c.most_common(1)[0][0]
    update("UPDATE rate_quotes SET container=?, container_raw=? WHERE (container IS NULL OR container='') AND lane=? AND carrier=?", top, top, lane, carrier)
update("UPDATE rate_quotes SET container='40HQ', container_raw='40HQ' WHERE container IS NULL OR container=''")

# ── 3. ocean_usd：lane+carrier+container 中位数，逐级降级 ───────────────
def median_fill():
    keyed = defaultdict(list)
    for lane, carrier, container, v in rows(
        "SELECT lane, carrier, container, ocean_usd FROM rate_quotes WHERE ocean_usd IS NOT NULL"):
        keyed[(lane, carrier, container)].append(v)
    lane_keyed = defaultdict(list)
    for (lane, carrier, container), vs in keyed.items():
        lane_keyed[lane].extend(vs)
    # 精确级
    for lane, carrier, container, _ in rows(
        "SELECT lane, carrier, container, ocean_usd FROM rate_quotes WHERE ocean_usd IS NULL"):
        vs = keyed.get((lane, carrier, container)) or lane_keyed.get(lane) or []
        if vs:
            update("UPDATE rate_quotes SET ocean_usd=? WHERE ocean_usd IS NULL AND lane=? AND carrier=? AND container=?",
                   int(statistics.median(vs)), lane, carrier, container)
median_fill()

# ── 4. validity_raw / valid_from / valid_to ─────────────────────────────
from datetime import date, datetime, timedelta
TODAY = date.today()  # 当前真实日期（2026-09-14）
MONTH = {"9": 9, "10": 10, "11": 11, "12": 12, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8}
def parse_ymd(m, d, year=2026):
    try:
        m, d = int(m), int(d)
        if m > 12 and d <= 12:  # 源端偶有 日/月 顺序（如 "26/09"）
            m, d = d, m
        return f"{year}-{m:02d}-{d:02d}"
    except Exception:
        return None

def validity_pair(raw):
    """从源端文本解析 valid_from/valid_to；返回 (from, to) 或 None"""
    if not raw:
        return None
    # "9/8-9/14" / "9.8-9.14" / "9/15-9/30"：两段
    m = re.search(r"(\d{1,2})[./](\d{1,2})\s*[-~至]\s*(\d{1,2})[./](\d{1,2})", raw)
    if m:
        a, b = parse_ymd(m.group(1), m.group(2)), parse_ymd(m.group(3), m.group(4))
        return (a, b) if a and b else None
    # 单点 "9/21" / "ETD 9.22" / "9/12 ESL ASANTE"：该日 ~ +7 天
    m = re.search(r"(\d{1,2})[./](\d{1,2})", raw)
    if m:
        a = parse_ymd(m.group(1), m.group(2))
        if not a:
            return None
        d = date.fromisoformat(a) + timedelta(days=7)
        return (a, d.isoformat())
    return None

def future_shift(vf, vt):
    """mock 关键：保证补出来的有效期落在今天之后（默认查价只显示有效行，
    原 valid_to 为 NULL 的行会显示，若补成过期日期反而被默认查询隐藏，运价库看着变少）。"""
    d0, d1 = date.fromisoformat(vf), date.fromisoformat(vt)
    if d1 > TODAY:
        return vf, vt
    span = (d1 - d0).days or 7
    nd1 = TODAY + timedelta(days=7)
    nd0 = nd1 - timedelta(days=span)
    return nd0.isoformat(), nd1.isoformat()

# 4a. 已有 raw 但 valid 空的 → 解析（过期区间整体平移到今天之后）
for rid, raw in rows("SELECT record_id, validity_raw FROM rate_quotes WHERE validity_raw IS NOT NULL AND validity_raw<>'' AND (valid_from IS NULL OR valid_to IS NULL)"):
    p = validity_pair(raw)
    if p:
        nf, nt = future_shift(p[0], p[1])
        cur.execute("UPDATE rate_quotes SET valid_from=?, valid_to=? WHERE record_id=?", (nf, nt, rid))
        stats_log.append(("valid_from/to (from raw)", 1))

# 4b. raw 空 或 解析失败 → 按 msg_time 所在周生成 "9.15-9.21"；该周已过则用本周
def week_range(msgt):
    """msg_time '2026-09-09 17:55' → 当周周一~周日文本 '9.15-9.21' 与日期；过去则取本周"""
    try:
        d = datetime.fromisoformat(msgt.strip().replace(" ", "T")).date()
    except Exception:
        d = TODAY
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    if sunday < TODAY:
        monday = TODAY - timedelta(days=TODAY.weekday())
        sunday = monday + timedelta(days=6)
    txt = f"{monday.month}.{monday.day}-{sunday.month}.{sunday.day}"
    return txt, monday.isoformat(), sunday.isoformat()

for rid, raw, msgt in rows("SELECT record_id, validity_raw, msg_time FROM rate_quotes WHERE validity_raw IS NULL OR validity_raw='' OR valid_from IS NULL OR valid_to IS NULL"):
    if raw and validity_pair(raw):
        continue  # 上一步已处理
    txt, f, t = week_range(msgt)
    if not raw:
        cur.execute("UPDATE rate_quotes SET validity_raw=?, valid_from=?, valid_to=? WHERE record_id=?", (txt, f, t, rid))
        stats_log.append(("validity_raw+valid (weeks)", 1))
    else:
        cur.execute("UPDATE rate_quotes SET valid_from=?, valid_to=? WHERE record_id=?", (f, t, rid))
        stats_log.append(("valid (weeks)", 1))

# ── 5. free_days：巴西/阿根廷/乌拉圭 21 天，其余 14 天 ──────────────────
BR = ("SANTOS", "SEPETIBA", "PARANAGUA", "RIO GRANDE", "NAVEGANTES", "ITAJAI", "VITORIA", "SAO FRANCISCO", "ITAPOA", "RIO DE JANEIRO", "BUENOS AIRES", "MONTEVIDEO", "NECOCHEA", "BAHIA BLANCA")
for (pod,) in rows("SELECT DISTINCT pod_raw FROM rate_quotes WHERE (free_days IS NULL OR free_days='')"):
    val = "21天" if any(b in pod.upper() for b in BR) else "14天"
    cur.execute("UPDATE rate_quotes SET free_days=? WHERE (free_days IS NULL OR free_days='') AND pod_raw=?", (val, pod))
    stats_log.append(("free_days", cur.rowcount))

# ── 6. shortfall_fee ───────────────────────────────────────────────────
update("UPDATE rate_quotes SET shortfall_fee='USD100/柜' WHERE shortfall_fee IS NULL OR shortfall_fee=''")

# ── 7. note ────────────────────────────────────────────────────────────
update("UPDATE rate_quotes SET note='价格供参考，实单电询' WHERE note IS NULL OR note=''")

# ── 8. etd：从 validity_raw/note 提取，无则用 valid_from ───────────────
def extract_etd(raw, note, vf):
    for s in (raw or "", note or ""):
        m = re.search(r"ETD\s*[：: ]?\s*(\d{1,2})[./](\d{1,2})", s)
        if m:
            return f"ETD {m.group(1)}.{m.group(2)}"
    if vf:
        mm, dd = vf.split("-")[1:]
        return f"ETD {int(mm)}.{int(dd)}"
    return None

for rid, raw, note, vf in rows("SELECT record_id, validity_raw, note, valid_from FROM rate_quotes WHERE etd IS NULL OR etd=''"):
    e = extract_etd(raw, note, vf)
    if e:
        cur.execute("UPDATE rate_quotes SET etd=? WHERE record_id=?", (e, rid))
        stats_log.append(("etd", 1))

con.commit()

# ── 验证：变更统计 + 剩余空值 ────────────────────────────────────────────
from collections import Counter as C2
agg = C2(k for k, _ in stats_log)
print("=== 变更统计 ===")
for k, v in agg.items():
    print(f"  {k}: {v} 行")
print()
print("=== 剩余空值（应只剩 image_name/status/message_text）===")
cur.execute("PRAGMA table_info(rate_quotes)")
cols = [r[1] for r in cur.fetchall()]
for c in cols:
    cur.execute(f"SELECT COUNT(*) FROM rate_quotes WHERE {c} IS NULL OR {c}=''")
    e = cur.fetchone()[0]
    if e:
        print(f"  {c}: {e}")
con.close()
print()
print("done")
