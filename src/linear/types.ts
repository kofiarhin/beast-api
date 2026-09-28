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
