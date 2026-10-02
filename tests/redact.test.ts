import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { createRedactingWriter, redactSecrets, secretValuesFromEnv } from "../src/util/redact.js";
import { FakeAgent, makeHarness, makeIssue, makeRepo, removeTmpDir, type Harness } from "./helpers.js";

// Built at runtime so this file never contains a literal token-shaped string.
const fake = (prefix: string, n = 36) => prefix + "A1b2C3d4E5".repeat(Math.ceil(n / 10)).slice(0, n);

describe("redactSecrets", () => {
  it("redacts known credential formats", () => {
    const tokens = [
      fake("lin_api_", 40),
      fake("sk-ant-", 40),
      fake("sk-proj-", 40),
      fake("ghp_", 36),
      fake("github_pat_", 40),
      fake("xoxb-", 30),
      "AKIA" + "ABCDEFGHIJKLMNOP",
      fake("eyJ", 20) + "." + fake("eyJ", 20) + "." + fake("", 20),
    ];
    for (const t of tokens) {
      const out = redactSecrets(`token is ${t} ok`, []);
      expect(out, t).toBe("token is [REDACTED] ok");
    }
  });

  it("redacts env-style assignments, auth headers and URL passwords", () => {
    expect(redactSecrets("LINEAR_WEBHOOK_SECRET=abc123def456", [])).toBe("LINEAR_WEBHOOK_SECRET=[REDACTED]");
    expect(redactSecrets('"OPENAI_API_KEY": "abcdef123456"', [])).toBe('"OPENAI_API_KEY": "[REDACTED]"');
    expect(redactSecrets("export DB_PASSWORD='hunter2hunter2'", [])).toBe("export DB_PASSWORD='[REDACTED]'");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop1234", [])).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSecrets("mongodb+srv://beast:s3cretPass@cluster.example.net/db", [])).toBe(
      "mongodb+srv://beast:[REDACTED]@cluster.example.net/db",
    );
  });

  it("redacts PEM private key blocks", () => {
    const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    expect(redactSecrets(`key:\n${pem}\ndone`, [])).toBe("key:\n[REDACTED]\ndone");
  });

  it("redacts exact secret values from the environment, whatever their format", () => {
    const secrets = secretValuesFromEnv({ LINEAR_WEBHOOK_SECRET: "plain words secret", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc" });
    expect(secrets).toEqual(["plain words secret"]);
    expect(redactSecrets("echo plain words secret", secrets)).toBe("echo [REDACTED]");
  });

  it("leaves ordinary code and prose alone", () => {
    const text = [
      "const token: string = getToken();",
      "Updated src/auth/session.ts and tests/session.test.ts",
      "Tests: 12 passed",
      "https://github.com/kofiarhin/beast-api/pull/1",
    ].join("\n");
    expect(redactSecrets(text, [])).toBe(text);
  });
});

describe("createRedactingWriter", () => {
  it("catches a secret split across chunks and suppresses multi-line private keys", () => {
    let out = "";
    const w = createRedactingWriter((t) => (out += t), ["split-secret-value"]);
    w.write("before split-sec");
    w.write("ret-value after\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow");
    w.write("IBAAKCAQEA\n-----END RSA PRIVATE KEY-----\ntail");
    w.end();
    expect(out).toBe("before [REDACTED] after\n[REDACTED]\ntail");
  });
});

describe("logger value redaction", () => {
  it("scrubs secrets from messages, string fields and string arrays", () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    const t = fake("ghp_", 36);
    log.warn(`push failed with ${t}`, { error: `bad ${t}`, list: [t], nested: { detail: t } });
    expect(lines[0]).not.toContain(t);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: "push failed with [REDACTED]",
      error: "bad [REDACTED]",
      list: ["[REDACTED]"],
      nested: { detail: "[REDACTED]" },
    });
  });
});

describe("worker secret redaction", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.worker.idle();
    removeTmpDir(h.root);
  });

  it("never stores or posts a secret the agent echoes in its summary or checks", async () => {
    const t = fake("sk-ant-", 40);
    const agent = new FakeAgent((req) => {
      fs.writeFileSync(path.join(req.workspace.path, "f.txt"), "x\n");
      return { summary: `Done. Used OPENAI_API_KEY=${t} to test.` };
    });
    h = makeHarness({ agent });
    const repo = makeRepo(h.workspaceRoot, "test-project");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: `node -e "console.log('${t}')"` } }));
    fs.mkdirSync(path.join(repo, "node_modules"));
    execFileSync("git", ["add", "package.json"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "pkg"], { cwd: repo });

    const job = h.store.createJob({
      deliveryId: "d-1",
      issue: makeIssue(),
      project: "TestProject",
      workspace: repo,
      agent: "fake",
      state: "queued",
    });
    h.worker.kick();
    await h.worker.idle();

    const done = h.store.getJob(job.id)!;
    expect(done.result!.agentSummary).toBe("Done. Used OPENAI_API_KEY=[REDACTED] to test.");
    expect(done.result!.verification!.checks.find((c) => c.name === "test")?.outputTail).toBe("[REDACTED]");
    for (const c of h.linear.comments) expect(c.body).not.toContain(t);
    // Nothing persisted under the data dir contains the secret either.
    const files = fs.readdirSync(h.dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    for (const f of files) expect(fs.readFileSync(path.join(f.parentPath, f.name), "utf8")).not.toContain(t);
  });
});
