import type { OnlineCrmPort } from './online-crm.service';

let port: OnlineCrmPort | null = null;

export function setSalesWorkflowClient(next: OnlineCrmPort | null): void {
  port = next;
}

export function salesWorkflowClient(): OnlineCrmPort | null {
  return port;
}
