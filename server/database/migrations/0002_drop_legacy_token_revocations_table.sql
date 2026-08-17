-- 舊的切線表（改用 fr_token_versions 之前的撤銷機制）已經沒有任何程式碼在
-- 讀寫它。DROP ... IF EXISTS 對從沒建過這張表的全新部署是無害的 no-op。
DROP TABLE IF EXISTS fr_token_revocations;
