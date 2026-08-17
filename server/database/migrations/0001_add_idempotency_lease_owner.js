// 補上 fr_idempotency_keys.lease_owner 給還沒有這欄的既有部署。
//
// 這欄從一開始就在 framework/idempotency.sql 的 CREATE TABLE 裡，所以全新的表
// 已經有它——這裡的 ALTER 只對「表已存在但沒有這欄」的舊部署有意義。用
// information_schema 檢查而不是 `ADD COLUMN IF NOT EXISTS`：後者要 MySQL
// 8.0.29+，跟 README 列的 MySQL 5.7+ 需求不合。

export async function up(connection) {
  const [columns] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'fr_idempotency_keys'
       AND COLUMN_NAME = 'lease_owner'`
  );

  if (columns.length > 0) {
    return;
  }

  await connection.query(
    "ALTER TABLE fr_idempotency_keys ADD COLUMN lease_owner CHAR(32) NOT NULL DEFAULT '' AFTER state"
  );
}
