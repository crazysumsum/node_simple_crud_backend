/**
 * 啟動一個測試用應用所需的最小 MySQL pool 替身。
 *
 * 這個形狀先前在十幾個測試檔裡各自複製了一份，於是框架每多用一個資料庫方法，
 * 就有十幾個地方要同步修改——而漏掉的那個會以 "this.target[method] is not a
 * function" 的形式炸在無關的測試裡。
 *
 * 啟動路徑上真正會用到的是：
 *   query()   連線驗證、撤銷名單首次載入
 *   execute() cluster 工作的租約 prepare、撤銷名單清理
 *   end()     關機
 */
export function fakeMySqlPool({ query, execute, end, rows = [{ ok: 1 }] } = {}) {
  const calls = { query: 0, execute: 0, end: 0 };

  return {
    calls,
    query: async (...args) => {
      calls.query += 1;
      return query ? query(...args) : [rows];
    },
    execute: async (...args) => {
      calls.execute += 1;
      return execute ? execute(...args) : [{ affectedRows: 0 }];
    },
    end: async (...args) => {
      calls.end += 1;
      return end?.(...args);
    }
  };
}

/** serviceOptions.mysqldatabase 的常用形式。 */
export function fakeDatabaseOptions(overrides) {
  return { pool: fakeMySqlPool(overrides) };
}
