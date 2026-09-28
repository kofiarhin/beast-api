import type { Logger } from "../logger.js";
import type { LinearIssue } from "./types.js";

/** Abstraction over the Linear API so the rest of Beast (and tests) never touch HTTP directly. */
export interface LinearClient {
  readonly configured: boolean;
  /** Returns null when Linear is not configured or the issue does not exist. Throws on transport errors. */
  fetchIssue(issueId: string): Promise<LinearIssue | null>;
  addComment(issueId: string, body: string): Promise<void>;
}

const ISSUE_QUERY = `
  query BeastIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      project { id name }
      labels { nodes { id name } }
    }
  }
`;

const COMMENT_MUTATION = `
  mutation BeastComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success }
  }
`;

interface IssueResponse {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string | null;
    project: { id: string; name: string } | null;
    labels: { nodes: { id: string; name: string }[] };
  } | null;
}

export class LinearGraphQLClient implements LinearClient {
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = "https://api.linear.app/graphql",
    private readonly timeoutMs = 8_000,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Linear API responded with HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (!json.data) throw new Error("Linear API returned no data");
    return json.data;
  }

  async fetchIssue(issueId: string): Promise<LinearIssue | null> {
    const data = await this.request<IssueResponse>(ISSUE_QUERY, { id: issueId });
    const issue = data.issue;
    if (!issue) return null;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
      labels: issue.labels.nodes.map((l) => ({ id: l.id, name: l.name })),
    };
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.request(COMMENT_MUTATION, { input: { issueId, body } });
  }
}

/** Used when LINEAR_API_KEY is not set: reads nothing, reports to the local log only. */
export class UnconfiguredLinearClient implements LinearClient {
  readonly configured = false;

  constructor(private readonly logger: Logger) {}

  async fetchIssue(): Promise<LinearIssue | null> {
    return null;
  }

  async addComment(issueId: string): Promise<void> {
    this.logger.info("linear not configured; comment not posted", { issueId });
  }
}
