/**
 * 把「表不存在」翻譯成一句說得出該跑哪個檔案的錯誤。
 *
 * 框架的 DDL 分成三個檔案（init.sql 與 database/framework/ 底下兩個），所以
 * 忘了跑其中一個是很容易犯的錯，而裸的 ER_NO_SUCH_TABLE 只會說表不見了，不會
 * 說它本來該從哪裡來。
 *
 * MySqlDatabaseService 會把驅動的錯誤包成 MySqlDatabaseOperationError 並保留
 * cause，所以要往下看一層。認不出來的錯誤原封不動往上拋——誤判成缺表會把真正
 * 的連線問題導向錯誤的排查方向。
 */
export function describeMissingTable(error, { table, sqlFile }) {
  const code = error?.cause?.code || error?.code;

  if (code !== "ER_NO_SUCH_TABLE") {
    return error;
  }

  return new Error(
    `Table "${table}" does not exist. Run ${sqlFile} against your database.`,
    { cause: error }
  );
}
