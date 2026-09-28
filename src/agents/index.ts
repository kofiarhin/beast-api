import type { Config } from "../config.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

type AdapterFactory = (config: Config) => AgentAdapter;

/**
 * Adapter registry. To add Claude Code, implement `AgentAdapter` in
 * `claude.ts` and register it here as `claude: (c) => new ClaudeAdapter(...)`.
 */
const ADAPTERS: Record<string, AdapterFactory> = {
  codex: (c) => new CodexAdapter({ bin: c.codexBin, model: c.codexModel }),
};

const PLANNED = new Set(["claude"]);

export function createAgentAdapter(config: Config): AgentAdapter {
  const factory = ADAPTERS[config.agent];
  if (factory) return factory(config);
  if (PLANNED.has(config.agent)) {
    throw new Error(`BEAST_AGENT=${config.agent} is not implemented yet`);
  }
  throw new Error(`Unknown BEAST_AGENT "${config.agent}". Supported: ${Object.keys(ADAPTERS).join(", ")}`);
}

export function supportedAgents(): string[] {
  return Object.keys(ADAPTERS);
}
