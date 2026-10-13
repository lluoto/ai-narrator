import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";
import {
  LoreScopeError,
  assertNoDuplicateClaims,
  loadCthulhuDataset,
  normalizeLoreRecord,
  queryLoreCandidates,
  readChapterInventory,
  readJsonlArtifact,
  validateChapterPairs,
} from "../dataset/cthulhu-dataset";
import { CTHULHU_DATASET_MANIFEST } from "../dataset/cthulhu-manifest";

const DATASET_PATH = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";
const reports: string[] = [];
const loaded = loadCthulhuDataset(CTHULHU_DATASET_MANIFEST, { datasetPath: DATASET_PATH, report: (message) => reports.push(message) });
const chapterMap = new Map(loaded.chapterInventory.map((entry) => [`${entry.workId}:${entry.chapter}`, entry]));

describe("Cthulhu dataset manifest 与真实数据", () => {
  it("manifest 恰有 7 部作品，最终解析路径被报告，Curse of Yig 保留 Gutenberg 双作者", () => {
    expect(CTHULHU_DATASET_MANIFEST.works).toHaveLength(7);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(loaded.resolvedPath);
    const yig = CTHULHU_DATASET_MANIFEST.works.find((work) => work.workId === "the_curse_of_yig");
    expect(yig?.authors).toEqual(["Zealia B. Bishop", "H. P. Lovecraft"]);
    const source = readFileSync(join(DATASET_PATH, yig!.sourceText.path), "utf8");
    expect(source.replaceAll("\r\n", "\n")).toContain("Author: Zealia B. Bishop\n        H. P. Lovecraft");
  });

  it("151 个章节文本与 151 metadata 一一对应且每部编号连续", () => {
    expect(loaded.chapterInventory).toHaveLength(151);
    for (const work of CTHULHU_DATASET_MANIFEST.works) {
      const entries = loaded.chapterInventory.filter((entry) => entry.workId === work.workId);
      expect(entries).toHaveLength(work.expectedChapters);
      expect(entries.map((entry) => entry.chapter)).toEqual(
        Array.from({ length: work.expectedChapters }, (_, index) => `ch${String(index + 1).padStart(3, "0")}`),
      );
    }
  });

  it("章节 txt/meta 固定清单 hash 漂移时加载失败", () => {
    const manifest = structuredClone(CTHULHU_DATASET_MANIFEST);
    manifest.works[0]!.chapterInventorySha256 = "0".repeat(64);
    expect(() => readChapterInventory(DATASET_PATH, manifest)).toThrow("chapter inventory hash mismatch");
  });

  it("7 个分作品 artifact 合计 145 条、覆盖 76/151 章节，不加载聚合文件", () => {
    expect(loaded.loaded).toBe(true);
    expect(loaded.candidates).toHaveLength(145);
    expect(loaded.rejectedRecords).toEqual([]);
    expect(loaded.loadedArtifacts).toHaveLength(7);
    expect(loaded.loadedArtifacts).not.toContain(CTHULHU_DATASET_MANIFEST.aggregateArtifact.path);
    expect(new Set(loaded.candidates.map((candidate) => `${candidate.workId}:${candidate.chapter}`)).size).toBe(76);
    expect(loaded.evidencePrecision).toBe("chunk");
  });

  it("145 条候选都有 manifest work、chapter 和完整块级 evidenceSpan", () => {
    const works = new Set(CTHULHU_DATASET_MANIFEST.works.map((work) => work.workId));
    for (const candidate of loaded.candidates) {
      expect(works.has(candidate.workId)).toBe(true);
      expect(chapterMap.has(`${candidate.workId}:${candidate.chapter}`)).toBe(true);
      expect(candidate.evidenceSpan.sourceHash).toHaveLength(64);
      expect(candidate.evidenceSpan.textHash).toHaveLength(64);
      expect(candidate.rightsEvidence.rightsStatus).toBe("unknown");
      expect(candidate.evidenceSpan.startLine).toBeLessThanOrEqual(candidate.evidenceSpan.endLine);
      expect(candidate.scope.evidencePrecision).toBe("chunk");
      expect(candidate.authority).toBe("declared_canon");
      expect(candidate.derivation).toBe("inferred");
      expect(candidate.status).toBe("candidate");
    }
  });

  it("properties 数组原样保留；schema 同时允许 object，不静默转换", () => {
    const arrayCandidate = loaded.candidates.find((candidate) => Array.isArray(candidate.payload.properties));
    expect(arrayCandidate).toBeDefined();
    expect(Array.isArray(arrayCandidate?.payload.properties)).toBe(true);

    const record = readJsonlArtifact(DATASET_PATH, "extracted/mountains_of_madness.jsonl")[1]!;
    const mutated = structuredClone(record);
    mutated.value.properties = { anatomy: ["star head", "gills"], count: 5 };
    const candidate = normalizeLoreRecord(mutated, CTHULHU_DATASET_MANIFEST, chapterMap);
    expect(candidate.payload.properties).toEqual({ anatomy: ["star head", "gills"], count: 5 });
  });

  it("source=Borellus 被保存为 quoteAttribution，不冒充 provenance；未知字段进入 extras", () => {
    const borellus = loaded.candidates.find((candidate) => candidate.payload.quoteAttribution === "Borellus");
    expect(borellus).toBeDefined();
    expect(borellus?.payload.extras).not.toHaveProperty("source");

    const record = structuredClone(readJsonlArtifact(DATASET_PATH, "extracted/dexter_ward.jsonl")[0]!);
    record.value.future_field = { untouched: [1, "two"] };
    expect(normalizeLoreRecord(record, CTHULHU_DATASET_MANIFEST, chapterMap).payload.extras.future_field).toEqual({ untouched: [1, "two"] });
  });

  it("cthulhu_all 为空时明确 ignored，不报告 loaded artifact", () => {
    expect(loaded.ignoredArtifacts).toEqual([{
      path: "extracted/cthulhu_all.jsonl",
      status: "ignored_empty_legacy_artifact",
      loaded: false,
    }]);
    expect(loaded.analysisArtifacts).toEqual([{
      path: "extracted/cthulhu_world_model.jsonl",
      status: "migration_analysis_only",
      loaded: false,
    }]);
  });
});

describe("小说 claim 与规则映射隔离", () => {
  it("聚合文件与 7 个分文件同时输入会触发重复判据", () => {
    const perWork = CTHULHU_DATASET_MANIFEST.works.flatMap((work) => readJsonlArtifact(DATASET_PATH, work.extractedArtifact.path));
    const aggregate = readJsonlArtifact(DATASET_PATH, CTHULHU_DATASET_MANIFEST.aggregateArtifact.path);
    expect(() => assertNoDuplicateClaims([...perWork, ...aggregate])).toThrow("duplicate claim");
  });

  it("dnd_mapping 不进入 payload，也不成为原著证据或可执行规则", () => {
    const aggregate = readJsonlArtifact(DATASET_PATH, CTHULHU_DATASET_MANIFEST.aggregateArtifact.path)[0]!;
    const candidate = normalizeLoreRecord(aggregate, CTHULHU_DATASET_MANIFEST, chapterMap);
    expect(candidate.payload).not.toHaveProperty("dnd_mapping");
    expect(candidate.payload.extras).not.toHaveProperty("dnd_mapping");
    expect(candidate.payload.extractionFlags.gameRule).toBe(true);
    expect(candidate.status).toBe("candidate");
    expect(candidate.warnings.join(" ")).toContain("ruleset adapter provenance is unknown");
  });

  it("把空 artifact 伪装成 required artifact 时加载失败，不会 loaded=true", () => {
    const manifest = structuredClone(CTHULHU_DATASET_MANIFEST);
    manifest.works[0]!.extractedArtifact = {
      path: "extracted/cthulhu_extracted/cthulhu_all.jsonl",
      sha256: CTHULHU_DATASET_MANIFEST.ignoredArtifacts[0]!.sha256,
      expectedRows: 0,
      expectedCoveredChapters: 0,
    };
    expect(() => loadCthulhuDataset(manifest, { datasetPath: DATASET_PATH, report: () => {} })).toThrow("required artifact is empty");
  });

  it("删除一个章节 metadata 后，章节配对判据必须红", () => {
    const work = CTHULHU_DATASET_MANIFEST.works[0]!;
    const directory = join(DATASET_PATH, work.chapterDirectory);
    const names = readdirSync(directory);
    const textNames = names.filter((name) => /^ch\d{3}\.txt$/.test(name)).sort();
    const metadataNames = names.filter((name) => /^ch\d{3}\.meta\.json$/.test(name)).sort().slice(1);
    expect(() => validateChapterPairs(work, textNames, metadataNames)).toThrow("chapter pair count mismatch");
  });
});

describe("manifest scope 查询", () => {
  const quiet = { datasetPath: DATASET_PATH, report: () => {} };

  it("只允许 mountains 时，结果不出现其它作品", () => {
    const candidates = queryLoreCandidates(CTHULHU_DATASET_MANIFEST, {
      domain: "entity_capability", allowedWorkIds: ["at_the_mountains_of_madness"], transferPolicy: "mechanic_only",
    }, quiet);
    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates.map((candidate) => candidate.workId))).toEqual(new Set(["at_the_mountains_of_madness"]));
    expect(candidates.every((candidate) => candidate.scope.canFillPlotFacts === false)).toBe(true);
  });

  it("allowedWorkIds 为空时显式报错，不退化成全库", () => {
    expect(() => queryLoreCandidates(CTHULHU_DATASET_MANIFEST, {
      domain: "cosmology", allowedWorkIds: [], transferPolicy: "plot_fact",
    }, quiet)).toThrow(LoreScopeError);
  });

  it("跨作品查询必须声明 manifest corpus scope；Yog-Sothoth 三个来源不合并", () => {
    const request = {
      domain: "cosmology" as const,
      allowedWorkIds: ["at_the_mountains_of_madness", "the_case_of_charles_dexter_ward", "the_dunwich_horror"] as const,
      entityNames: ["Yog-Sothoth"],
      transferPolicy: "analogy_only" as const,
    };
    expect(() => queryLoreCandidates(CTHULHU_DATASET_MANIFEST, { ...request, allowedWorkIds: [...request.allowedWorkIds] }, quiet)).toThrow("corpusScopeId");
    const candidates = queryLoreCandidates(CTHULHU_DATASET_MANIFEST, {
      ...request, allowedWorkIds: [...request.allowedWorkIds], corpusScopeId: "seven-work-corpus",
    }, quiet);
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((candidate) => candidate.workId)).size).toBe(3);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(3);
    expect(candidates.every((candidate) => candidate.scope.canFillPlotFacts === false)).toBe(true);
  });

  it("跨作品 plot_fact 即使声明 corpus scope 也拒绝", () => {
    expect(() => queryLoreCandidates(CTHULHU_DATASET_MANIFEST, {
      domain: "cosmology",
      allowedWorkIds: ["the_call_of_cthulhu", "the_dunwich_horror"],
      corpusScopeId: "seven-work-corpus",
      transferPolicy: "plot_fact",
    }, quiet)).toThrow("analogy_only");
  });

  it("era 无证据时返回空，不拿出版年份冒充故事时代", () => {
    expect(queryLoreCandidates(CTHULHU_DATASET_MANIFEST, {
      domain: "cosmology", allowedWorkIds: ["the_call_of_cthulhu"], era: "1920s", transferPolicy: "analogy_only",
    }, quiet)).toEqual([]);
  });
});

describe("运行时隔离", () => {
  it("普通 loader 不直连 dataset，compiled GameSession 只经受限 scope adapter 注入", () => {
    for (const file of ["src/api/game-session.ts", "src/world/world-model-loader.ts", "src/index.ts"]) {
      const imports = scanImports(readFileSync(file, "utf8"));
      expect(imports.some((entry) => importPointsTo(entry.path, "cthulhu-dataset"))).toBe(false);
    }
    const sessionImports = scanImports(readFileSync("src/api/game-session.ts", "utf8"));
    expect(sessionImports.some((entry) => importPointsTo(entry.path, "compiled-world-model-scope"))).toBe(true);
  });
});
