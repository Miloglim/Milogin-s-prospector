import { describe, expect, it } from 'vitest';
import { createCampaignService, type CampaignRepository } from '../../server/services/campaigns';
import { CAMPAIGN_STATES, type Campaign, type CampaignTarget, type CampaignPage } from '../../server/core/campaigns';
import { success, failure, type Result } from '../../server/core/crm';

const id='11111111-1111-4111-8111-111111111111';
const user='22222222-2222-4222-8222-222222222222';
const target='33333333-3333-4333-8333-333333333333';
const base:Campaign={campaignId:id,createdBy:user,name:'dry run',state:'draft',version:1,autoSend:false,confirmedAt:null,pausedAt:null,stoppedAt:null,stopReason:null,nextRunAt:null,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'};

function fake(): CampaignRepository & { value:Campaign; claimCalls:number; completeCalls:number } {
  let value=base,claimCalls=0,completeCalls=0;
  return {get value(){return value;},get claimCalls(){return claimCalls;},get completeCalls(){return completeCalls;},
    async create(){return success(value);}, async detail(){return success(value);}, async list(){return success({items:[value],total:1} satisfies CampaignPage);},
    async confirm(){value={...value,state:'scheduled',confirmedAt:'2026-10-16T00:01:00.000Z'};return success(value);},
    async pause(){value={...value,state:'paused'};return success(value);}, async claimDryRun(){claimCalls++;return success([]);}, async completeDryRun(){completeCalls++;return success(undefined);},
    async addTargets(){return success(0);},
  };
}

describe('server campaign dry-run contract',()=>{
  it('creates only a draft and never enables automatic sending',async()=>{
    const repo=fake();const service=createCampaignService(repo);const token='a'.repeat(43);
    const result=await service.create(token,{name:'dry run',idempotencyKey:'create-1',autoSend:true});
    expect(result.ok).toBe(true);
    expect(result.ok&&result.data.state).toBe('draft');
    expect(result.ok&&result.data.autoSend).toBe(false);
  });
  it('requires an explicit confirmation before scheduling',async()=>{
    const repo=fake();const service=createCampaignService(repo);const token='a'.repeat(43);
    const result=await service.confirm(token,{campaignId:id,expectedVersion:1,idempotencyKey:'confirm-1'});
    expect(result.ok).toBe(true);
    expect(result.ok&&result.data.state).toBe('scheduled');
    expect(CAMPAIGN_STATES).toContain('scheduled');
  });
  it('pause is an idempotent control and dry-run claim cannot send',async()=>{
    const repo=fake();const service=createCampaignService(repo);const token='a'.repeat(43);
    const paused=await service.pause(token,{campaignId:id,expectedVersion:1,idempotencyKey:'pause-1',reason:'manual'});
    expect(paused.ok).toBe(true);
    const claimed=await service.claimDryRun(token,{limit:10,workerId:'worker-1'});
    expect(claimed.ok).toBe(true);
    expect(repo.claimCalls).toBe(1);
    expect(repo.completeCalls).toBe(0);
    expect(target).toMatch(/[0-9a-f-]{36}/);
  });
});
