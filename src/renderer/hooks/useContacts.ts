import { invalidateDomain } from "../lib/cacheDeps";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { ONLINE_LIMITS } from '../../shared/online-crm';

// 客户页离开后短时间内返回，直接使用查询缓存；挂载中的 5 秒轮询和写入失效仍负责保持内容新鲜。
const CONTACT_CACHE_STALE_MS = 30_000;

export interface Contact {
  /** Explicit source identity: center records must never reach local ID APIs. */
  dataSource?: 'center';
  isShared?: boolean;
  canDelete?: boolean;
  contactId?: number;
  customerId?: string;
  contactVersion?: number;
  language?: string | null;
  touchStatus?: string;
  relationshipStage?: string | null;
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null; whatsapp?: string | null; sourceLevel1?: string | null; sourceLevel2?: string | null;
  linkedinUrl: string | null;
  companyId: number | null;
  companyName: string | null;
  businessType?: string | null;
  website?: string | null;
  country: string | null;
  clientType: string | null;
  stage: string | null;
  status: string | null;
  tags: string | null;
  extra: string | null;
  assignee: string | null;
  source: string | null;
  sourceDetail: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ContactFilters {
  stage?: string; status?: string; tags?: string; clientType?: string; country?: string;
  language?: string; touchStatus?: string; crmStage?: string;
}

export interface ContactDataResult<T = Contact> { success: boolean; data?: T; error?: string; }
export interface ContactDataPort {
  key: string;
  list(params?: { search?: string; page?: number } & ContactFilters): Promise<ContactDataResult<{ items: Contact[]; total: number }>>;
  listIds(params: { search?: string } & ContactFilters): Promise<ContactDataResult<{ ids: number[] }>>;
  getById(id: number): Promise<ContactDataResult>;
  upsert(input: Record<string, unknown>): Promise<ContactDataResult>;
  export?(kind: "contacts" | "notes", filters: { search?: string } & ContactFilters): Promise<ContactDataResult<string>>;
  canDelete?(id:number):boolean;
  deleteBatch?(ids:number[]):Promise<ContactDataResult<void>>;
  delete(id: number): Promise<ContactDataResult<void>>;
}

export function useContacts(params?: { search?: string; page?: number } & ContactFilters, port?: ContactDataPort) {
  return useQuery({
    queryKey: [port ? "center-contacts" : "contacts", port?.key, params],
    queryFn: () => port ? port.list(params) : window.api.invoke("contacts:list", params) as Promise<{
      success: boolean;
      data?: { items: Contact[]; total: number };
      error?: string;
    }>,
    // 翻页/筛选/搜索变更时保留上一份数据展示，不闪加载态
    placeholderData: keepPreviousData,
    staleTime: port ? CONTACT_CACHE_STALE_MS : 0,
    refetchInterval: port ? ONLINE_LIMITS.pollMs : false,
  });
}

export function useContact(id: number) {
  return useQuery({
    queryKey: ["contacts", id],
    queryFn: () => window.api.invoke("contacts:getById", id) as Promise<{
      success: boolean;
      data?: Contact;
      error?: string;
    }>,
    enabled: id > 0,
  });
}

export function useUpsertContact(port?: ContactDataPort) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      (port ? port.upsert(input) : window.api.invoke("contacts:upsert", input)) as Promise<{
        success: boolean;
        data?: Contact;
        error?: string;
      }>,
    onSuccess: () => { if (port) {for(const key of ['center-contacts','center-companies','center-company-detail','center-contact-detail','dashboard','search','center-assignment','inbox'])void qc.invalidateQueries({queryKey:[key]});} else invalidateDomain(qc, "contacts"); },
  });
}

export function useDeleteContact(port?: ContactDataPort) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      (port ? port.delete(id) : window.api.invoke("contacts:delete", id)) as Promise<{
        success: boolean;
        error?: string;
      }>,
    // ponytail: 乐观删除 — 点击立即从列表消失，失败回滚（消除 IPC+写盘+重拉的延迟感）
    onMutate: async (id) => {
      if (port) return { snapshot: [] };
      await qc.cancelQueries({ queryKey: ["contacts"] });
      const snapshot = qc.getQueriesData({ queryKey: ["contacts"] });
      qc.setQueriesData<{ success: boolean; data: { items: Contact[]; total: number } }>(
        { queryKey: ["contacts"] },
        (old) => old?.success && old.data
          ? { ...old, data: { ...old.data, items: old.data.items.filter(c => c.id !== id), total: old.data.total - 1 } }
          : old,
      );
      return { snapshot };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.snapshot) {
        for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void invalidateDomain(qc, "contacts", "send");
    },
  });
}
