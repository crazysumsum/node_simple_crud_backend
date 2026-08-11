CREATE DATABASE IF NOT EXISTS erp_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'erp_user'@'localhost' IDENTIFIED BY 'erp_password';
CREATE USER IF NOT EXISTS 'erp_user'@'%' IDENTIFIED BY 'erp_password';

GRANT ALL PRIVILEGES ON erp_dev.* TO 'erp_user'@'localhost';
GRANT ALL PRIVILEGES ON erp_dev.* TO 'erp_user'@'%';

USE erp_dev;

-- scope: "cluster" 的背景工作用這張表確保同一輪只有一個實例執行。
-- expires_at 為 0 代表目前沒有人持有；持有者崩潰時租約會自然過期，
-- 讓其他實例在下一輪接手。
CREATE TABLE IF NOT EXISTS job_leases (
  job_name    VARCHAR(190) NOT NULL,
  owner       VARCHAR(190) NOT NULL DEFAULT '',
  acquired_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (job_name)
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  role VARCHAR(60) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
);

INSERT INTO users (name, email, role)
VALUES ('System Admin', 'admin@example.com', 'admin')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  role = VALUES(role);
