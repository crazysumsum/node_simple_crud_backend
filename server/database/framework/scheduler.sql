-- 排程器的框架表。
--
-- fr_ 前綴代表這張表由框架擁有：它的結構隨框架版本演進，業務端不應該寫入它。
-- 沒有前綴的表（例如 users）是業務資料，框架不會碰。

USE erp_dev;

-- scope: "cluster" 的背景工作用這張表確保同一輪只有一個實例執行。
-- expires_at 為 0 代表目前沒有人持有；持有者崩潰時租約會自然過期，
-- 讓其他實例在下一輪接手。
CREATE TABLE IF NOT EXISTS fr_job_leases (
  job_name    VARCHAR(190) NOT NULL,
  owner       VARCHAR(190) NOT NULL DEFAULT '',
  acquired_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (job_name)
);

-- 每個實例每隔一段時間把自己的排程統計寫進這張表，讓「背景工作現在健康嗎」
-- 有一個不必翻日誌就答得出來的地方。
--
-- 這是「當下狀態」而不是歷史：一列代表一個實例的一件工作，重複寫入同一列。
-- 沒有歷史紀錄是刻意的，要趨勢請查日誌。
--
-- 列的生命週期綁在實例上，不綁在應用重啟上。多實例部署下「啟動時清空整張表」
-- 是錯的——滾動重啟會讓每個實例輪流抹掉同儕正在用的列。所以：
--   正常關機  實例刪掉自己的列（instance_id = 自己）。
--   崩潰      沒人刪，靠 updated_at 過期，由任何一個實例的 flush 順手清掉。
-- 兩條路徑都只會刪掉確定不再更新的列。
--
-- instance_id 就是 fr_job_leases.owner，所以「誰持有租約」與「誰真的跑了」
-- 可以直接對照。IP 不能當識別：一台機器有多張網卡，容器裡拿到的通常是無意義
-- 的臨時位址，所以 address 只是給人看的附註，可能為空。
--
-- updated_at 用資料庫時鐘（UNIX_TIMESTAMP()），last_* 用實例自己的時鐘。前者
-- 讓「這一列有多新鮮」在實例之間可比較，後者才是事情實際發生的時間。
--
-- 主鍵是 190 + 190 個字元；utf8mb4 下是 1520 bytes，在 InnoDB DYNAMIC 的
-- 3072 bytes 索引上限之內。
CREATE TABLE IF NOT EXISTS fr_job_stats (
  instance_id          VARCHAR(190)    NOT NULL,
  job_name             VARCHAR(190)    NOT NULL,
  host                 VARCHAR(190)    NOT NULL DEFAULT '',
  address              VARCHAR(64)     NOT NULL DEFAULT '',
  scope                VARCHAR(16)     NOT NULL DEFAULT '',
  -- 最近一次「嘗試」的起訖，不分成功失敗。租約搶輸不算一次嘗試，只計入
  -- skipped_not_leader，否則 cluster 工作在非 leader 的實例上會看起來一直在動。
  last_started_at      BIGINT UNSIGNED NULL,
  last_finished_at     BIGINT UNSIGNED NULL,
  -- 最近一次成功。consecutive_failures 只說失敗了幾次，說不出「多久沒成功
  -- 過」——而後者才是判斷嚴重程度的依據。
  last_success_at      BIGINT UNSIGNED NULL,
  -- running | succeeded | failed | timedOut | leaseFailed
  last_outcome         VARCHAR(24)     NULL,
  last_duration_ms     INT UNSIGNED    NULL,
  last_error           VARCHAR(500)    NULL,
  runs                 INT UNSIGNED    NOT NULL DEFAULT 0,
  failures             INT UNSIGNED    NOT NULL DEFAULT 0,
  timeouts             INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_overlapping  INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_not_leader   INT UNSIGNED    NOT NULL DEFAULT 0,
  consecutive_failures INT UNSIGNED    NOT NULL DEFAULT 0,
  updated_at           BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (instance_id, job_name),
  -- 過期清理按 updated_at 掃描。
  KEY fr_job_stats_updated_at (updated_at)
);
