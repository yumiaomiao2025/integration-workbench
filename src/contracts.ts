export type RepositoryBinding = {
  projectId: number;
  instance?: string;
  path: string;
  branch: string;
  commitSha: string;
};

export type TaskInput = {
  title: string;
  url: string;
  frontend: RepositoryBinding | null;
  backend: RepositoryBinding | null;
};

type EvidenceBase = {
  id: string;
  at: string;
};

export type NetworkEvidence = EvidenceBase & {
  kind: 'network';
  method: string;
  url: string;
  status: number | null;
  duration: number;
  error: string;
  resourceType: string;
};

export type ConsoleEvidence = EvidenceBase & {
  kind: 'console';
  level: string;
  message: string;
  source: string;
};

export type Evidence = NetworkEvidence | ConsoleEvidence;

export type Task = TaskInput & {
  id: string;
  createdAt: string;
  evidence: Evidence[];
};

export type CandidateTab = { id: string; title: string; url: string };

export type ConnectionStatus = {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
  message: string;
  activeTaskId: string | null;
};

export type LiveCapture = {
  revision: number;
  state: 'inactive' | 'waiting' | 'choose' | 'attached';
  message: string;
  startedAt: string | null;
  tab: CandidateTab | null;
  candidates: CandidateTab[];
  entries: Evidence[];
};
