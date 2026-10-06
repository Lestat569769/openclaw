import type { MemorySessionTarget } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";

export type MemoryForgetReport = {
  agentId: string;
  dryRun: boolean;
  mixedLineagePolicy: "whole-entry" | "refuse";
  disposition: "preview" | "refused" | "applied" | "no-targets";
  effects: "none" | "applied";
  cachePolicy: {
    scope: "agent-wide-recomputable";
    sourceAttribution: "unavailable";
    reasons: ["unattributed-schema", "unpublished-cache-coverage"];
  };
  indexScope: Array<{
    id: string;
    path: string;
    source: string;
    reasons: Array<
      "changed-file" | "indexed-memory-snapshot" | "selected-session" | "stale-internal-session"
    >;
  }>;
  sessionIds: string[];
  participantMatches: Array<{ actorId: string; identities: MemorySessionTarget["participants"] }>;
  sessionResolutions: Array<{
    sessionId: string;
    sessionKey?: string;
    source: "live" | "archived" | "unresolved";
  }>;
  entryKeys: string[];
  mixedLineageEntryKeys: string[];
  untargetableEntryKeys: string[];
  curatedWrites: Array<{ relativePath: string; observedAt: number }>;
  artifacts: {
    memoryFiles: number;
    memoryEntries: number;
    memoryLines: number;
    sessionCorpusFiles: number;
    sessionCorpusLines: number;
    indexChunks: number;
    indexSources: number;
    ftsRows: number;
    vectorRows: number;
    embeddingCacheRows: number;
    shortTermEntries: number;
    seenHashScopes: number;
    backups: number;
    originRows: number;
  };
  refusals: string[];
};

export function summarizeParticipantMatches(
  targets: MemorySessionTarget[],
  participants?: string[],
): MemoryForgetReport["participantMatches"] {
  return [...new Set(participants ?? [])].toSorted().map((actorId) => ({
    actorId,
    identities: [
      ...new Map(
        targets.flatMap((target) =>
          target.participants
            .filter((identity) => identity.id === actorId)
            .map((identity) => [JSON.stringify(identity), identity] as const),
        ),
      ).values(),
    ],
  }));
}
