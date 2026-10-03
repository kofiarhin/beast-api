export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearProject {
  id: string | null;
  name: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  project: LinearProject | null;
  labels: LinearLabel[];
}

export interface LinearComment {
  id: string;
  body: string;
  issueId: string | null;
  /** Null for comments without a human author (integrations, deleted users). */
  userId: string | null;
  edited: boolean;
}
