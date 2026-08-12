-- JWT 撤銷的框架表。
--
-- fr_ 前綴代表這張表由框架擁有：它的結構隨框架版本演進，業務端不應該寫入它。
-- 沒有前綴的表（例如 users）是業務資料，框架不會碰。

USE erp_dev;

-- 撤銷以「切線」表示：subject 在 revoked_before 之前簽發的 token 一律無效。
--
-- 一個使用者一列，重複撤銷只是把切線往後推，所以表的大小由使用者數決定，
-- 不隨撤銷次數增長。這也是不記錄個別 token 的原因——記 token 的話，一個
-- 被盜帳號的每次登入都會多一列。
--
-- revoked_before 與 updated_at 都是 UNIX 秒，且一律取自資料庫時鐘：多實例的
-- 機器時鐘不保證同步，用本機時間會讓一台機器簽發的 token 逃過另一台發起的撤銷。
CREATE TABLE IF NOT EXISTS fr_token_revocations (
  subject        VARCHAR(190)    NOT NULL,
  revoked_before BIGINT UNSIGNED NOT NULL,
  reason         VARCHAR(190)    NOT NULL DEFAULT '',
  updated_at     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (subject),
  -- 清理工作按 revoked_before 掃描：切線比最長 token 壽命還舊時，不可能還有
  -- 活著的 token 早於它，那一列就沒有意義了。
  KEY fr_token_revocations_revoked_before (revoked_before)
);
