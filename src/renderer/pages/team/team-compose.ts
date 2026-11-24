import type { TeamEmailReferencePayload } from '../../../shared/online-crm';

const TEAM_COMPOSE_KEY = 'prospector.team.compose';

export interface TeamEmailReferenceDraft {
  teamId: string;
  memberUserId: string;
  referenceId: string;
  payload: TeamEmailReferencePayload;
  createdAt: string;
}

export function saveTeamEmailReference(draft: TeamEmailReferenceDraft): void {
  sessionStorage.setItem(TEAM_COMPOSE_KEY, JSON.stringify(draft));
}

export function readTeamEmailReference(): TeamEmailReferenceDraft | null {
  const raw = sessionStorage.getItem(TEAM_COMPOSE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TeamEmailReferenceDraft;
    return parsed && typeof parsed.teamId === 'string' && typeof parsed.memberUserId === 'string' && parsed.payload ? parsed : null;
  } catch {
    // A corrupt local draft must not block the team page.
    return null;
  }
}

export function clearTeamEmailReference(): void {
  sessionStorage.removeItem(TEAM_COMPOSE_KEY);
}
