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
