CREATE DATABASE IF NOT EXISTS erp_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'erp_user'@'localhost' IDENTIFIED BY 'erp_password';
CREATE USER IF NOT EXISTS 'erp_user'@'%' IDENTIFIED BY 'erp_password';

GRANT ALL PRIVILEGES ON erp_dev.* TO 'erp_user'@'localhost';
GRANT ALL PRIVILEGES ON erp_dev.* TO 'erp_user'@'%';

USE erp_dev;

-- 框架自己的表都在 database/framework/ 底下，並以 fr_ 前綴命名。這個檔案只
-- 負責建庫、建帳號，以及業務範例資料——兩者分開，是為了讓「這張表誰擁有、
-- 升級框架時什麼會變」一眼看得出來。

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
