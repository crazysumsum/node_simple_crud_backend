-- Idempotency 的框架表。
--
-- fr_ 前綴代表這張表由框架擁有：它的結構隨框架版本演進，業務端不應該寫入它。
-- 沒有前綴的表（例如 users）是業務資料，框架不會碰。

USE erp_dev;

-- 共享的 idempotency 紀錄。主鍵就是互斥鎖：INSERT 成功代表搶到這個 key，
-- 主鍵衝突代表別的實例先到，所以多實例部署下同一個 key 只會執行一次。
--
-- store_key 是「前綴 + SHA-256 十六進位」，比 job 名稱長，所以這裡是 255 而
-- 不是其他框架表用的 190。
--
-- state 有三個值，expires_at 的含義跟著它變：
--   pending     處理中的租約。持有者崩潰時，這是那一列唯一的解鎖方式，所以它
--               必須長於任何請求可能的執行時間（啟動時會強制檢查）。
--   completed   回應可被重播到什麼時候。
--   unavailable 業務操作成功了，但回應沒能保存（寫入失敗、大於
--               maxResponseBytes、或回應根本沒經過 res.json()）。這一列的存在
--               只為了一件事：讓重試拿到 409 而不是重新執行一個已經做完的操作。
--               status_code 與 response 為 NULL，expires_at 用完整的 TTL。
--
-- 這張表的欄位沒有變過，unavailable 只是 state 多了一個值——既有部署不需要
-- 執行任何 DDL。
CREATE TABLE IF NOT EXISTS fr_idempotency_keys (
  store_key   VARCHAR(255)      NOT NULL,
  fingerprint CHAR(64)          NOT NULL,
  state       VARCHAR(16)       NOT NULL,
  status_code SMALLINT UNSIGNED NULL,
  response    MEDIUMTEXT        NULL,
  expires_at  BIGINT UNSIGNED   NOT NULL,
  PRIMARY KEY (store_key),
  -- 清理工作按 expires_at 分批刪除。
  KEY fr_idempotency_keys_expires_at (expires_at)
);
