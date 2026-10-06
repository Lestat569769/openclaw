import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as sqlite from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ingestion from "./dreaming-ingestion-state.js";
import {
  readSessionIngestionState,
  writeSessionIngestionState,
} from "./dreaming-ingestion-state.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { runSessionBackfill } from "./session-backfill.js";
import { sessionExclusionReason, type SessionIngestionSource } from "./session-ingestion.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import { readShortTermRecallEntries } from "./short-term-promotion.js";

describe("native opt-in operation-wide mixed-lineage refusal", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let db: DatabaseSync;
  const args = () => ({
    cfg: fixture.cfg,
    agentId: "main",
    sessionIds: ["target"],
    mixedLineage: "refuse" as const,
  });
  const ingestionSource = (): SessionIngestionSource => ({
    agentId: "main",
    absolutePath: path.join(fixture.stateDir, "target.jsonl"),
    foreign: false,
    sessionPath: "sessions/main/target",
    stateKey: "fixture-target",
    scope: "main:target",
    buildOptions: {},
    sessionOrigin: { agentId: "main", sessionId: "target" },
  });
  const addOrigin = (sessionId: string) =>
    recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          entryKey: "selected",
          agentId: "main",
          sessionId,
          sessionKey: null,
          originClass: "owner",
          observedAt: 1,
        },
      ],
    });

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("native-forget-refusal-");
    await seedMemoryForgetSession("target");
    await seedMemoryForgetSession("survivor");
    db = sqlite.openOpenClawAgentDatabase({ agentId: "main" }).db;
    addOrigin("target");
    const memory =
      "<!-- openclaw-memory-promotion:selected -->\n- Selected violet fixture fact.\nUnrelated amber authoritative fact.\n<!-- openclaw-memory-promotion:untraced -->\n- Untraced freeform fact.\n";
    await fs.writeFile(path.join(fixture.workspaceDir, "MEMORY.md"), memory);
    await fs.writeFile(path.join(fixture.workspaceDir, "USER.md"), "Unrelated curated profile.\n");
    const corpus = path.join(fixture.workspaceDir, "memory/.dreams/session-corpus");
    await fs.mkdir(corpus, { recursive: true });
    await fs.writeFile(
      path.join(corpus, "fixture.md"),
      "[main/sessions/main/target#L1] Selected violet fixture fact.\n[main/sessions/main/survivor#L1] Surviving corpus fact.\n",
    );
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir: fixture.workspaceDir,
      entries: [
        {
          key: "selected",
          value: { key: "selected", path: "memory/source.md", snippet: "selected" },
        },
      ],
    });
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir: fixture.workspaceDir,
      entries: [
        {
          key: "backup",
          value: { createdAt: "2026-10-05T00:00:00Z", content: memory, contentHash: "fixture" },
        },
      ],
    });
    await writePhaseSignalStore(fixture.workspaceDir, {
      version: 1,
      updatedAt: "2026-10-05T00:00:00Z",
      entries: { selected: { key: "selected", lightHits: 1, remHits: 0 } },
    });
    await writeSessionIngestionState(fixture.workspaceDir, {
      version: 3,
      files: {},
      seenMessages: {
        "main:sessions/main/target": ["selected-hash"],
        "main:sessions/main/survivor": ["survivor-hash"],
      },
    });
    expect((await storage.loadSqliteVecExtension({ db })).ok).toBe(true);
    storage.ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    const rows = [
      ["selected", "MEMORY.md", "memory", memory, "owner", "interactive"],
      [
        "same-file-survivor",
        "MEMORY.md",
        "memory",
        "Unrelated amber authoritative fact.",
        "owner",
        "interactive",
      ],
      [
        "outside",
        "memory/unrelated.md",
        "memory",
        "Unrelated authoritative indexed fact.",
        "owner",
        "interactive",
      ],
      [
        "session",
        "sessions/main/target.jsonl",
        "sessions",
        "Selected session fact.",
        "owner",
        "interactive",
      ],
      [
        "internal",
        "sessions/main/internal.jsonl",
        "sessions",
        "Old internal fact.",
        "system",
        "heartbeat",
      ],
    ];
    for (const [id, file, source, text, originClass, kind] of rows) {
      db.prepare(
        "INSERT INTO memory_index_chunks (id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES (?,?,?,1,1,'shared','test',?,?,1)",
      ).run(id!, file!, source!, text!, storage.encodeMemoryEmbedding([1, 0]));
      db.prepare("INSERT INTO memory_index_chunks_vec (id,embedding) VALUES (?,?)").run(
        id!,
        new Float32Array([1, 0]),
      );
      db.prepare(
        "INSERT INTO memory_index_chunk_provenance (chunk_id,origin_class,session_kind,observed_at) VALUES (?,?,?,1)",
      ).run(id!, originClass!, kind!);
    }
    for (const hash of ["shared", "unpublished-no-chunk"]) {
      db.prepare(
        "INSERT INTO memory_embedding_cache (provider,model,provider_key,hash,embedding,dims,updated_at) VALUES ('test','test','test',?,?,2,1)",
      ).run(hash, storage.encodeMemoryEmbedding([1, 0]));
    }
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  async function snapshot() {
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    const rows = tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all(),
    ]);
    return {
      tables,
      rows,
      memory: await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8"),
      corpus: await fs.readFile(
        path.join(fixture.workspaceDir, "memory/.dreams/session-corpus/fixture.md"),
        "utf8",
      ),
      profile: await fs.readFile(path.join(fixture.workspaceDir, "USER.md"), "utf8"),
      shortTerm: await readMemoryCoreWorkspaceEntries({
        namespace: SHORT_TERM_RECALL_NAMESPACE,
        workspaceDir: fixture.workspaceDir,
      }),
      backups: await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
        workspaceDir: fixture.workspaceDir,
      }),
      phase: await readPhaseSignalStore(fixture.workspaceDir, "2026-10-05T00:00:00Z"),
      ingestion: await readSessionIngestionState(fixture.workspaceDir),
    };
  }

  it("refuses mixed preview and apply with every planned effect unchanged, including schema and unpublished cache", async () => {
    addOrigin("survivor");
    const before = await snapshot();
    for (const dryRun of [false, true]) {
      const report = await forgetMemoryEntries({ ...args(), dryRun });
      expect(await snapshot()).toEqual(before);
      expect(report).toMatchObject({
        dryRun,
        disposition: "refused",
        effects: "none",
        mixedLineagePolicy: "refuse",
        mixedLineageEntryKeys: ["selected"],
        untargetableEntryKeys: ["untraced"],
        cachePolicy: {
          scope: "agent-wide-recomputable",
          sourceAttribution: "unavailable",
          reasons: ["unattributed-schema", "unpublished-cache-coverage"],
        },
        artifacts: { embeddingCacheRows: 2, shortTermEntries: 1, backups: 1 },
      });
      expect(report.refusals).toContain(
        "Mixed lineage: the entire operation was refused; no forget effects were applied.",
      );
      expect(await snapshot()).toEqual(before);
      expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
      expect(sessionExclusionReason(ingestionSource())).toBeUndefined();
    }
  });

  it("applies single-origin refusal mode with whole-file invalidation and conservative shared/unpublished cache cleanup", async () => {
    const preview = await forgetMemoryEntries({ ...args(), dryRun: true });
    expect(preview).toMatchObject({
      disposition: "preview",
      effects: "none",
      untargetableEntryKeys: ["untraced"],
    });
    expect(preview.indexScope).toEqual(
      expect.arrayContaining([
        {
          id: "same-file-survivor",
          path: "MEMORY.md",
          source: "memory",
          reasons: ["changed-file"],
        },
        {
          id: "internal",
          path: "sessions/main/internal.jsonl",
          source: "sessions",
          reasons: ["stale-internal-session"],
        },
      ]),
    );
    const report = await forgetMemoryEntries(args());
    expect(report).toEqual({
      ...preview,
      dryRun: false,
      disposition: "applied",
      effects: "applied",
    });
    for (const table of [
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_chunks_vec",
    ]) {
      expect(db.prepare(`SELECT id FROM ${table}`).all()).toEqual([{ id: "outside" }]);
    }
    expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toContain(
      "Unrelated amber authoritative fact.",
    );
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toContain(
      "Untraced freeform fact.",
    );
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    expect(listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { sessionId: "target" },
    ]);
    expect(sessionExclusionReason(ingestionSource())).toBe("forgotten");
    const persisted = sqlite.openNodeSqliteDatabase(
      sqlite.resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      { readOnly: true },
    );
    try {
      expect(
        persisted.prepare("SELECT session_id, reason FROM memory_session_tombstones").all(),
      ).toEqual([{ session_id: "target", reason: "forgotten" }]);
    } finally {
      persisted.close();
    }
  });

  it("keeps a successfully forgotten fixture excluded from backfill after durable application", async () => {
    const nowMs = Date.parse("2026-10-05T12:00:00Z");
    const fact = "Remember the violet fixture launch setting.";
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "target",
      sessionKey: "agent:main:target",
      message: {
        role: "user",
        content: fact,
        timestamp: nowMs,
        __openclaw: { senderIsOwner: true },
      },
    });
    const options = {
      agentId: "main",
      workspaceDir: fixture.workspaceDir,
      apply: true,
      nowMs,
      timezone: "UTC",
    };
    expect((await runSessionBackfill(options)).stagedEntries).toBe(1);
    expect((await forgetMemoryEntries(args())).disposition).toBe("applied");
    expect((await runSessionBackfill(options)).stagedEntries).toBe(0);
    expect(
      (await readShortTermRecallEntries({ workspaceDir: fixture.workspaceDir, nowMs })).map(
        (entry) => entry.snippet,
      ),
    ).not.toContain(fact);
  });

  it("discloses ingestion partial effects, preserves the exact cause, and completes a retry", async () => {
    const cause = Object.assign(new Error("synthetic ingestion write failure"), { code: "EIO" });
    const fault = vi.spyOn(ingestion, "writeSessionIngestionState").mockRejectedValueOnce(cause);
    const error = await forgetMemoryEntries(args()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "partial effects may exist and durable source exclusion remains",
      ),
      cause,
    });
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).toContain("retrying the same selectors");
    expect((error as Error).message).toContain("does not restore removed material");
    expect(listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { sessionId: "target" },
    ]);
    expect(sessionExclusionReason(ingestionSource())).toBe("forgotten");
    expect(listMemoryEntryOrigins({ agentId: "main" })).toHaveLength(1);
    expect(await fs.readFile(path.join(fixture.workspaceDir, "MEMORY.md"), "utf8")).toContain(
      "Selected violet",
    );
    expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    fault.mockRestore();
    expect((await forgetMemoryEntries(args())).disposition).toBe("applied");
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    expect(sessionExclusionReason(ingestionSource())).toBe("forgotten");
  });

  it("preserves a pre-marker failure without claiming durable exclusion", async () => {
    const cause = new Error("synthetic vector preparation failure");
    vi.spyOn(storage, "loadSqliteVecExtension").mockRejectedValueOnce(cause);
    await expect(forgetMemoryEntries(args())).rejects.toBe(cause);
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
    expect(sessionExclusionReason(ingestionSource())).toBeUndefined();
  });

  it("retains explicit legacy whole-entry deletion compatibility", async () => {
    addOrigin("survivor");
    const report = await forgetMemoryEntries({ ...args(), mixedLineage: "whole-entry" });
    expect(report).toMatchObject({
      mixedLineagePolicy: "whole-entry",
      disposition: "applied",
      effects: "applied",
      mixedLineageEntryKeys: ["selected"],
    });
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
  });

  it("refuses new mixed lineage between preview and apply without exclusion", async () => {
    expect((await forgetMemoryEntries({ ...args(), dryRun: true })).disposition).toBe("preview");
    addOrigin("survivor");
    const before = await snapshot();
    expect((await forgetMemoryEntries(args())).disposition).toBe("refused");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["preparation", "admission"] as const)(
    "reprepares mixed lineage added during %s before any effects",
    async (timing) => {
      let afterWriter: Awaited<ReturnType<typeof snapshot>> | undefined;
      if (timing === "preparation") {
        const list = storage.listMemoryFiles;
        vi.spyOn(storage, "listMemoryFiles").mockImplementationOnce(async (...input) => {
          const result = await list(...input);
          addOrigin("survivor");
          afterWriter = await snapshot();
          return result;
        });
      } else {
        const write = sqlite.withOpenClawAgentDatabaseWrite;
        let admissions = 0;
        vi.spyOn(sqlite, "withOpenClawAgentDatabaseWrite").mockImplementation(async (...input) => {
          admissions += 1;
          if (admissions === 2) {
            addOrigin("survivor");
            afterWriter = await snapshot();
          }
          return write(...input);
        });
      }
      const report = await forgetMemoryEntries(args());
      expect(report).toMatchObject({
        disposition: "refused",
        effects: "none",
        mixedLineageEntryKeys: ["selected"],
      });
      expect(afterWriter).toBeDefined();
      expect(await snapshot()).toEqual(afterWriter);
    },
  );
});
