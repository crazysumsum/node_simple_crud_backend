import { isIP } from "node:net";

/**
 * 把來源位址收斂成一個配額 key。
 *
 * IPv4 一個位址就是一個客戶端，直接用。IPv6 不是：一個客戶通常整段 /64 都是
 * 他的，那 1.8×10^19 個位址是同一個人。直接用完整位址當 key 有兩個後果——
 * 他可以無限繞過配額，而且每繞一次就在限流器的 Map 裡多一個桶。
 *
 * 聚合到前綴同時解決兩件事：配額回到「以客戶為單位」這個本來的語意，key 空間
 * 從天文數字壓回與 IPv4 同級。
 */
export function clientQuotaKey(address, prefixLength) {
  const text = String(address ?? "").trim();

  if (isIP(text) !== 6) {
    // IPv4、或解不出來的東西（"unknown"、unix socket 路徑）原樣使用。解不出來
    // 的位址聚合不了，但它們的數量本來就有限。
    return text;
  }

  // IPv4-mapped（::ffff:203.0.113.7）是 IPv4 客戶端經由雙堆疊 socket 進來的
  // 常態形式，Node 在沒有 trust proxy 時就直接給這個。它的前 80 個 bit 全是
  // 固定的，聚合到 /64 會讓**每一個** IPv4 客戶端共用同一個桶——一個人就能
  // 用光所有人的配額。當成 IPv4 處理。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);

  if (mapped) {
    return mapped[1];
  }

  const bytes = ipv6Bytes(text);
  const fullBytes = prefixLength >> 3;
  const remainingBits = prefixLength & 7;
  const masked = bytes.slice(0, fullBytes);

  if (remainingBits > 0) {
    masked.push(bytes[fullBytes] & (0xff << (8 - remainingBits)));
  }

  // 不還原成標準 IPv6 字串：這是一個 key，不是一個位址，而且帶著前綴長度才
  // 能避免 /48 與 /64 在同一個 Map 裡互相碰撞。
  return `${masked.map((byte) => byte.toString(16).padStart(2, "0")).join("")}/${prefixLength}`;
}

/**
 * 把一個 IPv6 位址展開成 16 個 byte。
 *
 * 呼叫端已經用 isIP() 驗過，而且 IPv4-mapped 在上面就分流掉了，所以這裡不再
 * 重複驗證——多寫的防禦分支是走不到的程式碼，只會讓覆蓋率報告說謊。
 */
function ipv6Bytes(text) {
  // zone id（fe80::1%eth0）標的是介面，不是位址。
  const [address] = text.split("%");
  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  // "::" 代表中間省略的那幾組零；沒有 "::" 時 tail 是 undefined，headGroups
  // 已經是完整的 8 組。
  const groups = [
    ...headGroups,
    ...Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => "0"),
    ...tailGroups
  ];
  const bytes = [];

  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }

  return bytes;
}
