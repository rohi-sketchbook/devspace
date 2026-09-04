import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentIsolationMode,
  type LocalAgentProfile,
  type LocalAgentProvider,
  type LocalAgentWriteMode,
} from "./local-agent-profiles.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  isolation?: LocalAgentIsolationMode;
  usageThresholdPercent?: number;
  imagePaths?: string[];
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  usageThresholdPercent?: number;
  imagePaths?: string[];
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      thinking?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      thinking?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  return parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--thinking <level>] [--write-mode <mode>] [--isolation <mode>] [--usage-threshold <percent>] [--image <path>] "<prompt>"',
  );
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--thinking <level>] [--write-mode <mode>] [--usage-threshold <percent>] [--image <path>] "<prompt>"',
  );
  return {
    agentId: parsed.target,
    prompt: parsed.prompt,
    model: parsed.model,
    thinking: parsed.thinking,
    ...(parsed.writeMode ? { writeMode: parsed.writeMode } : {}),
    ...(parsed.usageThresholdPercent !== undefined ? { usageThresholdPercent: parsed.usageThresholdPercent } : {}),
    ...(parsed.imagePaths?.length ? { imagePaths: parsed.imagePaths } : {}),
  };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) throw new Error(usage);

  let model: string | undefined;
  let thinking: string | undefined;
  let writeMode: LocalAgentWriteMode | undefined;
  let isolation: LocalAgentIsolationMode | undefined;
  let usageThresholdPercent: number | undefined;
  const imagePaths: string[] = [];
  const promptParts: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (part === "--image") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --image.");
      imagePaths.push(value);
      index += 1;
      continue;
    }
    if (part?.startsWith("--image=")) {
      const value = part.slice("--image=".length).trim();
      if (!value) throw new Error("Missing value for --image.");
      imagePaths.push(value);
      continue;
    }
    if (part === "--model" || part === "--thinking" || part === "--write-mode" || part === "--isolation" || part === "--usage-threshold") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error(`Missing value for ${part}.`);
      ({ model, thinking, writeMode, isolation, usageThresholdPercent } = applyOption(
        part,
        value,
        { model, thinking, writeMode, isolation, usageThresholdPercent, imagePaths },
      ));
      index += 1;
      continue;
    }
    const option = ["--model=", "--thinking=", "--write-mode=", "--isolation=", "--usage-threshold="]
      .find((prefix) => part?.startsWith(prefix));
    if (option) {
      const value = part.slice(option.length).trim();
      if (!value) throw new Error(`Missing value for ${option.slice(0, -1)}.`);
      ({ model, thinking, writeMode, isolation, usageThresholdPercent } = applyOption(
        option.slice(0, -1),
        value,
        { model, thinking, writeMode, isolation, usageThresholdPercent, imagePaths },
      ));
      continue;
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) throw new Error(usage);

  return {
    target,
    prompt,
    model,
    thinking,
    ...(writeMode ? { writeMode } : {}),
    ...(isolation ? { isolation } : {}),
    ...(usageThresholdPercent !== undefined ? { usageThresholdPercent } : {}),
    ...(imagePaths.length ? { imagePaths } : {}),
  };
}

function applyOption(
  option: string,
  value: string,
  current: Omit<ParsedLocalAgentRunArgs, "target" | "prompt">,
): Omit<ParsedLocalAgentRunArgs, "target" | "prompt"> {
  if (option === "--model") return { ...current, model: value };
  if (option === "--thinking") return { ...current, thinking: value };
  if (option === "--write-mode") {
    if (value !== "read_only" && value !== "allowed" && value !== "full_access") {
      throw new Error("--write-mode must be read_only, allowed, or full_access.");
    }
    return { ...current, writeMode: value };
  }
  if (option === "--isolation") {
    if (value !== "auto" && value !== "worktree" && value !== "checkout") {
      throw new Error("--isolation must be auto, worktree, or checkout.");
    }
    return { ...current, isolation: value };
  }
  if (option === "--usage-threshold") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error("--usage-threshold must be a number between 0 and 100.");
    }
    return { ...current, usageThresholdPercent: parsed };
  }
  return current;
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  thinkingOverride?: string,
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model,
      thinking: thinkingOverride ?? profile.thinking,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride,
      thinking: thinkingOverride,
    };
  }

  return undefined;
}

export function formatAvailableLocalAgentTargets(profiles: LocalAgentProfile[]): string {
  const profileNames = profiles.map((profile) => profile.name);
  const parts = [
    profileNames.length > 0 ? `profiles: ${profileNames.join(", ")}` : undefined,
    `providers: ${LOCAL_AGENT_PROVIDERS.join(", ")}`,
  ].filter(Boolean);
  return parts.join("; ");
}
