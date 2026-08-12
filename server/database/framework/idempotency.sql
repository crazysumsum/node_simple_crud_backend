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
-- expires_at 有兩種含義，看 state：
--   pending   處理中的租約。持有者崩潰時，這是那一列唯一的解鎖方式，所以它
--             必須長於任何請求可能的執行時間（啟動時會強制檢查）。
--   completed 回應可被重播到什麼時候。
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
