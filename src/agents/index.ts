import type { Config } from "../config.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

type AdapterFactory = (config: Config) => AgentAdapter;

/** Adapter registry. To add an agent, implement `AgentAdapter` and register it here. */
const ADAPTERS: Record<string, AdapterFactory> = {
  codex: (c) => new CodexAdapter({ bin: c.codexBin, model: c.codexModel }),
  claude: (c) => new ClaudeAdapter({ bin: c.claudeBin, model: c.claudeModel }),
};

export function createAgentAdapter(config: Config): AgentAdapter {
  const factory = ADAPTERS[config.agent];
  if (factory) return factory(config);
  throw new Error(`Unknown BEAST_AGENT "${config.agent}". Supported: ${Object.keys(ADAPTERS).join(", ")}`);
}

export function supportedAgents(): string[] {
  return Object.keys(ADAPTERS);
}
