-- Idempotency 的框架表。
--
-- fr_ 前綴代表這張表由框架擁有：它的結構隨框架版本演進，業務端不應該寫入它。
-- 沒有前綴的表（例如 users）是業務資料，框架不會碰。
--
-- 不寫 USE：這個檔案永遠透過已經連到 DB_NAME 指定資料庫的連線執行
-- （scripts/migrate.js 或 docker-entrypoint-initdb.d 的 --database），寫死
-- 資料庫名稱只會在改了 DB_NAME 的環境裡把表建到錯的地方。

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
-- lease_owner 是這一次 begin() 的隨機憑證，寫入時同時附帶。租約過期後別的
-- 呼叫者可以刪掉這一列重搶，一旦搶到，這欄就換成新的值；原本那個晚到的
-- complete／fail／markUnavailable 帶著舊的 owner，UPDATE／DELETE 會影響 0 列，
-- 而不是覆寫或刪掉接手者的資料。不比對這一欄的話，兩個持有者可以在同一列上
-- 互相覆蓋——沒有任何症狀，只有回應對不上或客戶端被鎖住。
CREATE TABLE IF NOT EXISTS fr_idempotency_keys (
  store_key   VARCHAR(255)      NOT NULL,
  fingerprint CHAR(64)          NOT NULL,
  state       VARCHAR(16)       NOT NULL,
  lease_owner CHAR(32)          NOT NULL DEFAULT '',
  status_code SMALLINT UNSIGNED NULL,
  response    MEDIUMTEXT        NULL,
  expires_at  BIGINT UNSIGNED   NOT NULL,
  PRIMARY KEY (store_key),
  -- 清理工作按 expires_at 分批刪除。
  KEY fr_idempotency_keys_expires_at (expires_at)
);

-- 既有部署：這張表原本沒有 lease_owner。DEFAULT '' 讓既有列在 ALTER 之後仍然
-- 合法，但那些列此刻沒有真正的持有者——下一次晚到的寫入仍然可能命中它們，
-- 直到它們自然過期或被下一輪 begin() 換上新的 owner 為止。
--
-- 既有部署的補欄由 database/migrations/0001_add_idempotency_lease_owner.js
-- 自動處理（`npm run migrate` 時執行一次），不再需要手動下 ALTER TABLE。
