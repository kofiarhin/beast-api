import type { Logger } from "../logger.js";
import type { LinearComment, LinearIssue } from "./types.js";

/** Abstraction over the Linear API so the rest of Beast (and tests) never touch HTTP directly. */
export interface LinearClient {
  readonly configured: boolean;
  /** Returns null when Linear is not configured or the issue does not exist. Throws on transport errors. */
  fetchIssue(issueId: string): Promise<LinearIssue | null>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Authoritative comment details (author, issue). Null when unavailable. */
  fetchComment(commentId: string): Promise<LinearComment | null>;
  /** The Linear user ID Beast itself acts as, so its own comments never count as approvals. */
  fetchViewerId(): Promise<string | null>;
  /**
   * The user who most recently added `labelId` to the issue, from the issue history.
   * Null when it cannot be determined unambiguously.
   */
  fetchLabelAdder(issueId: string, labelId: string): Promise<string | null>;
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

const COMMENT_QUERY = `
  query BeastCommentDetails($id: String!) {
    comment(id: $id) {
      id
      body
      editedAt
      issue { id }
      user { id }
    }
  }
`;

const VIEWER_QUERY = `
  query BeastViewer {
    viewer { id }
  }
`;

const LABEL_HISTORY_QUERY = `
  query BeastLabelHistory($id: String!) {
    issue(id: $id) {
      history(first: 100) {
        nodes {
          createdAt
          addedLabelIds
          actor { id }
        }
      }
    }
  }
`;

interface CommentResponse {
  comment: {
    id: string;
    body: string;
    editedAt: string | null;
    issue: { id: string } | null;
    user: { id: string } | null;
  } | null;
}

interface HistoryResponse {
  issue: {
    history: { nodes: { createdAt: string; addedLabelIds: string[] | null; actor: { id: string } | null }[] };
  } | null;
}

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

  async fetchComment(commentId: string): Promise<LinearComment | null> {
    const { comment } = await this.request<CommentResponse>(COMMENT_QUERY, { id: commentId });
    if (!comment) return null;
    return {
      id: comment.id,
      body: comment.body,
      issueId: comment.issue?.id ?? null,
      userId: comment.user?.id ?? null,
      edited: comment.editedAt !== null,
    };
  }

  private viewerId: string | null = null;

  async fetchViewerId(): Promise<string | null> {
    this.viewerId ??= (await this.request<{ viewer: { id: string } | null }>(VIEWER_QUERY, {})).viewer?.id ?? null;
    return this.viewerId;
  }

  async fetchLabelAdder(issueId: string, labelId: string): Promise<string | null> {
    const { issue } = await this.request<HistoryResponse>(LABEL_HISTORY_QUERY, { id: issueId });
    const additions = (issue?.history.nodes ?? [])
      .filter((n) => n.addedLabelIds?.includes(labelId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = additions[0];
    if (!latest?.actor?.id) return null;
    // Two additions at the same instant by different users: ambiguous.
    if (additions.some((n) => n.createdAt === latest.createdAt && n.actor?.id !== latest.actor?.id)) return null;
    return latest.actor.id;
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

  async fetchComment(): Promise<LinearComment | null> {
    return null;
  }

  async fetchViewerId(): Promise<string | null> {
    return null;
  }

  async fetchLabelAdder(): Promise<string | null> {
    return null;
  }
}
