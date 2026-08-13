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
  "src/services/idempotency/IdempotencyService.js": { lines: 95, branches: 85 },
  // functions 在這裡是必要的：這個檔案曾經 lines 88%／branches 86% 穩穩過關，
  // 而 fail()（釋放 key 的唯一路徑）與過期清理的刪除分支從來沒有被呼叫過。
  "src/services/idempotency/IdempotencyStore.js": {
    lines: 95,
    branches: 90,
    functions: 90
  },
  "src/services/mysqldatabase/MySqlDatabaseService.js": { lines: 95, branches: 88 },
  "src/framework/middleware/apiDispatcher.js": { lines: 88, branches: 70 },
  "src/framework/upload/uploadMiddleware.js": { lines: 90, branches: 80 },
  // 這個閘門是上傳記憶體唯一的全域上限——沒有它，「同時解析數 × 每個請求的
  // 位元組上限」就沒有任何東西在強制。它的兩種壞法都是安靜的：上限失效會等到
  // OOM killer 才顯現，而槽位洩漏是單向累積的，上傳會在某個時點之後全部開始
  // 回 503，沒有任何錯誤指向原因。
  "src/framework/upload/uploadConcurrencyGate.js": {
    lines: 95,
    branches: 95,
    functions: 95
  },
  "src/framework/middleware/requestTimeout.js": { lines: 80, branches: 60 },
  "src/services/auth/JwtService.js": { lines: 95, branches: 95 },
  "src/framework/configuration/SecretValue.js": { lines: 90, branches: 90 },
  // 排程器錯了的後果是背景工作靜靜停掉，或 cluster 工作在每個實例上重複執行。
  // 兩者都不會在開發時被發現。
  "src/services/scheduler/SchedulerService.js": { lines: 90, branches: 85 },
  "src/services/scheduler/JobLeaseStore.js": { lines: 95, branches: 95 },
  "src/services/scheduler/normalizeJobDefinition.js": { lines: 90, branches: 78 },
  // 統計表的刪除是這個框架裡少數會弄丟別人資料的操作：deleteInstance 少一個
  // WHERE，滾動重啟就會讓每個實例輪流抹掉同儕的列。而症狀只是「表怎麼常常
  // 是空的」，不會有任何錯誤。
  "src/services/scheduler/JobStatsStore.js": { lines: 95, branches: 90, functions: 95 },
  // 發佈統計的降級路徑（寫不進去就自己關掉）平常永遠不會執行到，但它是「診斷
  // 資料壞掉不該拖垮應用」這個承諾的唯一實作。
  "src/services/scheduler/jobs/JobStatsFlushJob.js": {
    lines: 95,
    branches: 90,
    functions: 95
  },
  // 限流器壞掉有兩種形態：安靜地不再限流，或把佇列卡死。前者在開發時完全看
  // 不出來，後者只在有負載時才發作。
  "src/services/requestLimiter/RequestLimiterService.js": { lines: 85, branches: 75 },
  // Token bucket 的每一種錯誤都不會拋錯，只會讓限流「跟想的不一樣」：被擋住的
  // IP 永遠解不開、清理免費送配額、時鐘回撥倒扣 token。
  "src/services/requestLimiter/RateLimitStore.js": {
    lines: 95,
    branches: 95,
    functions: 95
  },
  // 共享 idempotency 的失效是安靜的：互斥一旦破掉，症狀只是「偶爾重複執行」，
  // 而那在單機開發時永遠不會出現。
  "src/services/idempotency/MySqlIdempotencyStore.js": {
    lines: 95,
    branches: 90,
    functions: 95
  },
  // 撤銷壞掉的每一種形態都是安靜的：快照沒更新、切線算錯一秒、清理刪早了、
  // fail open 的上界比錯邊，症狀全都是「已撤銷的 token 還能用」，不會有任何
  // 錯誤浮現。
  "src/services/tokenRevocation/TokenRevocationService.js": {
    lines: 95,
    branches: 95,
    functions: 95
  },
  // 熔斷的判斷住在這裡。回 401 而不是 503、或是漏掉快照可用性這一問，兩者
  // 都不會讓任何測試以外的東西出聲。
  "src/services/auth/jwtAuthStrategy.js": {
    lines: 95,
    branches: 95,
    functions: 95
  },
  // 每請求 service scope 的拆解。這裡的洩漏是安靜且累積的——scope 沒關就是
  // request-scoped 的資源一路留著，症狀要跑上幾天才顯現，而那時已經沒有線索
  // 指回這個中間件。拆解本身還跑在回應送出之後，那裡拋錯沒有人接得住。
  "src/framework/services/requestServiceScope.js": {
    lines: 95,
    branches: 95,
    functions: 95
  },
  // 設定正規化器多數不需要下限：它們在啟動時執行，寫錯會立刻炸。這一個是
  // 例外——它守的是 CORS 白名單與 trustProxy 跳數，而放寬檢查的後果（萬用
  // 字元 origin 通過、trustProxy 接受 true）不會有任何啟動期症狀。
  "src/framework/security/normalizeSecurityConfig.js": {
    lines: 95,
    branches: 95,
    functions: 95
  }
};

const serverRoot = fileURLToPath(new URL("../", import.meta.url));

function parseLcov(content) {
  const files = new Map();
  let current = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("SF:")) {
      current = {
        lines: null,
        linesHit: 0,
        branches: null,
        branchesHit: 0,
        functions: null,
        functionsHit: 0
      };
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
    if (key === "FNF") current.functions = value;
    if (key === "FNH") current.functionsHit = value;
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

    // functions 是選填的。它抓的是「整個方法從來沒有被呼叫過」——那種洞不會
    // 讓行覆蓋掉多少（一個沒被呼叫的短方法只有一兩行），所以只看 lines 與
    // branches 的話，一個函式覆蓋 53% 的檔案照樣可以穩穩通過門檻。
    if (floor.functions !== undefined) {
      const functions = percentage(entry.functionsHit, entry.functions);

      if (functions < floor.functions) {
        failures.push(
          `${file}: functions ${functions.toFixed(2)}% is below the ${floor.functions}% floor`
        );
      }
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
