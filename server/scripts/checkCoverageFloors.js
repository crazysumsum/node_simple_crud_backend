import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 高風險檔案的 per-file 覆蓋率下限。
 *
 * 全域門檻保護不了個別檔案：這些檔案佔總行數的比例很小，兩個一起退化到 60%，
 * 全域門檻仍然過關。而它們正是出錯代價最高的地方——交易的取消與 rollback、
 * idempotency 的身分範圍與降級回應。
 *
 * 下限刻意設在目前值稍下方：留一點重構空間，但擋得住整段測試被刪掉。這不是
 * 追求數字，而是防止已經釘住的失敗路徑悄悄鬆脫。新增檔案不必列在這裡，只有
 * 「壞掉會很貴而且不容易在開發時發現」的才需要。
 */
const FLOORS = {
  "src/framework/idempotency/IdempotencyManager.js": { lines: 95, branches: 85 },
  "src/framework/idempotency/IdempotencyStore.js": { lines: 85, branches: 80 },
  "src/services/mysqldatabase/MySqlDatabaseService.js": { lines: 95, branches: 88 },
  "src/framework/middleware/apiDispatcher.js": { lines: 88, branches: 70 },
  "src/framework/upload/uploadMiddleware.js": { lines: 90, branches: 75 },
  "src/framework/middleware/requestTimeout.js": { lines: 80, branches: 60 },
  "src/services/auth/JwtService.js": { lines: 95, branches: 95 },
  "src/framework/configuration/SecretValue.js": { lines: 90, branches: 90 },
  // 排程器錯了的後果是背景工作靜靜停掉，或 cluster 工作在每個實例上重複執行。
  // 兩者都不會在開發時被發現。
  "src/services/scheduler/SchedulerService.js": { lines: 90, branches: 85 },
  "src/services/scheduler/JobLeaseStore.js": { lines: 95, branches: 95 },
  "src/services/scheduler/normalizeJobDefinition.js": { lines: 90, branches: 78 }
};

const serverRoot = fileURLToPath(new URL("../", import.meta.url));

function parseLcov(content) {
  const files = new Map();
  let current = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("SF:")) {
      current = { lines: null, linesHit: 0, branches: null, branchesHit: 0 };
      files.set(line.slice(3), current);
      continue;
    }

    if (!current) {
      continue;
    }

    const [key, value] = [line.slice(0, line.indexOf(":")), Number(line.slice(line.indexOf(":") + 1))];

    if (key === "LF") current.lines = value;
    if (key === "LH") current.linesHit = value;
    if (key === "BRF") current.branches = value;
    if (key === "BRH") current.branchesHit = value;
    if (line === "end_of_record") current = null;
  }

  return files;
}

// 分母為 0 代表這個檔案沒有可量測的分支，視為通過而不是 0%。
const percentage = (hit, total) => (total === 0 ? 100 : (hit / total) * 100);

async function main() {
  const lcovPath = process.argv[2] || path.join(serverRoot, "coverage", "lcov.info");
  let content;

  try {
    content = await readFile(lcovPath, "utf8");
  } catch (error) {
    console.error(
      `Coverage report not found at ${lcovPath}: ${error.message}\nRun "npm run test:coverage" first.`
    );
    process.exitCode = 1;
    return;
  }

  const measured = parseLcov(content);
  const failures = [];

  for (const [file, floor] of Object.entries(FLOORS)) {
    const entry = measured.get(file);

    // 檔案被改名或搬走卻沒更新這份清單，等於門檻靜默失效——那比覆蓋率下降更糟。
    if (!entry) {
      failures.push(`${file}: not present in the coverage report (renamed or moved?)`);
      continue;
    }

    const lines = percentage(entry.linesHit, entry.lines);
    const branches = percentage(entry.branchesHit, entry.branches);

    if (lines < floor.lines) {
      failures.push(`${file}: lines ${lines.toFixed(2)}% is below the ${floor.lines}% floor`);
    }

    if (branches < floor.branches) {
      failures.push(
        `${file}: branches ${branches.toFixed(2)}% is below the ${floor.branches}% floor`
      );
    }
  }

  if (failures.length > 0) {
    console.error("Per-file coverage floors not met:");

    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }

    console.error(
      "\nThese files are gated individually because a global threshold cannot detect them regressing."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Per-file coverage floors met for ${Object.keys(FLOORS).length} high-risk files.`
  );
}

await main();
