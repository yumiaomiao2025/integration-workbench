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
  page?: { title: string; url: string };
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
  target: 'frontend' | 'backend' | 'insufficient' | null;
  summary: string;
  findings: { index: number; reason: string }[];
  nextSteps: string[];
};

export type AnalysisMessage = { role: 'user' | 'assistant'; text: string };
export type CandidateTab = { id: string; title: string; url: string };
export type ConnectedTab = CandidateTab & { startedAt: string };

export type ConnectionStatus = {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
  message: string;
};

export type LiveCapture = {
  revision: number;
  state: 'waiting' | 'choose' | 'attached';
  message: string;
  tabs: ConnectedTab[];
  candidates: CandidateTab[];
  entries: Evidence[];
};
