import path from "node:path";

/**
 * Path rules for admin operations. A path must already be canonical when requested: Beast
 * never normalizes a request into something different from what the human approved.
 */
const PATH_CHARS = /^\/[A-Za-z0-9._@+,=:/-]*$/;
const MAX_PATH = 4096;
const MAX_COMPONENT = 255;

/** Pseudo filesystems where chown/inspect make no sense. Always rejected. */
const UNSUPPORTED_ROOTS = ["/proc", "/sys", "/dev", "/run/user"];

/** Approved protected locations: the path itself or anything under it. "/" is protected only exactly. */
export const PROTECTED_PREFIXES: readonly string[] = [
  "/etc",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/var/lib/dpkg",
  "/root",
];

/** Approved protected names: any path component matching one of these is protected. */
export const PROTECTED_NAMES: readonly string[] = [
  ".ssh",
  "authorized_keys",
  ".codex",
  ".claude",
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "id_*",
];

export function isUnder(root: string, candidate: string): boolean {
  if (root === "/") return candidate.startsWith("/");
  return candidate === root || candidate.startsWith(root + "/");
}

function matchesGlob(name: string, glob: string): boolean {
  if (glob.startsWith("*")) return name.endsWith(glob.slice(1)) && name.length > glob.length - 1;
  if (glob.endsWith("*")) return name.startsWith(glob.slice(0, -1)) && name.length > glob.length - 1;
  return name === glob;
}

/** Returns an error message, or undefined when `p` is a canonical, safe absolute path. */
export function checkPathSyntax(p: unknown): string | undefined {
  if (typeof p !== "string") return "path must be a string";
  if (p.length === 0 || p.length > MAX_PATH) return "path length is out of range";
  if (!PATH_CHARS.test(p)) return "path contains unsupported characters (allowed: letters, digits and ._@+,=:-/)";
  if (p === "/") return undefined;
  if (p.endsWith("/")) return "path must not end with /";
  if (p.includes("//")) return "path must not contain //";
  const parts = p.slice(1).split("/");
  for (const part of parts) {
    if (part === "." || part === "..") return "path traversal is not allowed";
    if (part.startsWith("-")) return "path components must not start with -";
    if (part.length > MAX_COMPONENT) return "path component is too long";
  }
  if (path.posix.normalize(p) !== p) return "path must be canonical";
  if (UNSUPPORTED_ROOTS.some((r) => isUnder(r, p))) return `paths under ${UNSUPPORTED_ROOTS.join(", ")} are not supported`;
  return undefined;
}

export interface ProtectionContext {
  /** Beast's own code, data, policy and audit locations. */
  beastPaths: readonly string[];
  extraProtectedPaths?: readonly string[];
  extraProtectedServices?: readonly string[];
}

/** True when the path (or, for a recursive change, something under it) is a protected target. */
export function isProtectedPath(p: string, ctx: ProtectionContext, recursive = false): boolean {
  if (p === "/") return true;
  const prefixes = [...PROTECTED_PREFIXES, ...ctx.beastPaths, ...(ctx.extraProtectedPaths ?? [])];
  if (prefixes.some((root) => isUnder(root, p))) return true;
  if (p.slice(1).split("/").some((part) => PROTECTED_NAMES.some((g) => matchesGlob(part, g)))) return true;
  if (recursive) {
    // A recursive change covering a protected location, or a whole home directory
    // (SSH keys, credentials), is itself protected.
    if (prefixes.some((root) => isUnder(p, root))) return true;
    const parts = p.slice(1).split("/");
    if (parts[0] === "home" && parts.length <= 2) return true;
  }
  return false;
}
