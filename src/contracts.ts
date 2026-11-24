export type RepositoryBranch = { name: string; commitSha: string };

export type RepositoryBinding = {
  projectId: number;
  instance?: string;
  path: string;
  branches: RepositoryBranch[];
};

export type TaskInput = {
  title: string;
  url: string;
  frontend: RepositoryBinding[];
  backend: RepositoryBinding[];
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
  chromeDataDir?: string;
  evidence: Evidence[];
};

export type EvidenceAnalysis = {
  target: 'frontend' | 'backend' | 'insufficient';
  summary: string;
  findings: { index: number; reason: string }[];
  nextSteps: string[];
};

export type CandidateTab = { id: string; title: string; url: string };

export type ConnectionStatus = {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
  message: string;
};

export type LiveCapture = {
  revision: number;
  state: 'waiting' | 'choose' | 'attached';
  message: string;
  startedAt: string | null;
  tab: CandidateTab | null;
  candidates: CandidateTab[];
  entries: Evidence[];
};
