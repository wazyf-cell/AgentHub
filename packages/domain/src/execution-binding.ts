import type { DaemonProvider } from "./daemon-provider.ts";

export interface ExecutionBinding {
  version: 1;
  runtimeId: string;
  provider: DaemonProvider;
  modelId?: string;
  capabilityIds: string[];
}
