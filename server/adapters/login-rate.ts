import type { LoginGate, OnlineConfig, ClockPort } from "../core/auth";
const MILLISECONDS_PER_SECOND = 1000;
export class LoginRateGate implements LoginGate {
  private readonly buckets = new Map<string,{ count: number; expires: number }>();
  constructor(private readonly config: OnlineConfig, private readonly clock: ClockPort) {}
  private consume(key: string, maximum: number): boolean {
    const now = this.clock.now();
    for(const [id,bucket] of this.buckets) if(bucket.expires<=now) this.buckets.delete(id);
    const bucket = this.buckets.get(key);
    if(bucket) { if(bucket.count>=maximum) return false; bucket.count++; return true; }
    if(this.buckets.size>=this.config.rate_bucket_max) return false;
    this.buckets.set(key,{count:1,expires:now+this.config.login_window_seconds*MILLISECONDS_PER_SECOND});
    return true;
  }
  allow(key: string, address?: string): boolean {
    // Both buckets count all attempts; rotating emails cannot bypass the address ceiling.
    if(address && !this.consume(`ip:${address}`,this.config.login_ip_max_attempts)) return false;
    return this.consume(`account:${key}`,this.config.login_max_attempts);
  }
}
