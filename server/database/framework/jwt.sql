-- JWT 撤銷的框架表。
--
-- fr_ 前綴代表這張表由框架擁有：它的結構隨框架版本演進，業務端不應該寫入它。
-- 沒有前綴的表（例如 users）是業務資料，框架不會碰。
--
-- 不寫 USE：這個檔案永遠透過已經連到 DB_NAME 指定資料庫的連線執行
-- （scripts/migrate.js 或 docker-entrypoint-initdb.d 的 --database），寫死
-- 資料庫名稱只會在改了 DB_NAME 的環境裡把表建到錯的地方。

-- 撤銷以「版本號」表示：token 帶著簽發當下的 ver，比目前版本舊就是已撤銷。
--
-- 上一版用的是時間切線（revoked_before）——「這個時間點之前簽發的 token 全部
-- 作廢」。它可以運作，但它把時間當成版本號，於是每一個毛病都跟時鐘有關：iat
-- 取自簽發節點的時鐘而切線取自資料庫時鐘，偏快的節點簽出的 token 逃得掉；切線
-- 只有秒精度，所以要 +1 秒去蓋同一秒；而且列不能太早刪掉，否則仍然活著的
-- token 會隨著切線一起消失而復活——那條「保留期必須蓋過 token 壽命」的關係
-- 跨了兩個設定檔，還得靠啟動檢查擋著。
--
-- 單調遞增的計數器一個都不需要：比較是 ver < version，兩邊都不是時間。
--
-- 一個使用者一列，而且永久保留：表的大小由使用者數決定，不隨撤銷次數增長，
-- 所以沒有清理工作，也沒有「刪太早」這種失效模式。version 從 1 開始，沒有列
-- 代表 0，兩者對「從未撤銷過」的判定一致。
CREATE TABLE IF NOT EXISTS fr_token_versions (
  subject    VARCHAR(190)    NOT NULL,
  version    BIGINT UNSIGNED NOT NULL DEFAULT 1,
  reason     VARCHAR(190)    NOT NULL DEFAULT '',
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (subject)
);

-- 舊的切線表已經沒有任何程式碼在讀寫它。這裡刻意不自動 DROP：那會刪掉資料，
-- 而且這個檔案是會被重複執行的。確認過部署都切換完之後手動執行：
--
--   DROP TABLE IF EXISTS fr_token_revocations;
