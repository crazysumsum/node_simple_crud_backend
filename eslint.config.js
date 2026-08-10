import js from "@eslint/js";
import globals from "globals";

// 這個框架大量使用 duck typing（例如 typeof x.require === "function"），沒有型別
// 檢查護航，所以 lint 的重點放在能真正擋下缺陷的規則：未使用的變數、意外的
// 全域變數、被丟掉的 Promise 等，而不是排版偏好。
const correctness = {
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "none"
    }
  ],
  "no-undef": "error",
  "no-console": "off",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": "error",
  "no-return-await": "error",
  // 對 `req.auth = await strategies.authenticate(...)` 這類寫法會誤報。req 與 res
  // 是逐請求物件，不會被其他請求共用，這裡不存在該規則設想的競態。
  "require-atomic-updates": "off",
  "no-promise-executor-return": "error",
  "no-unmodified-loop-condition": "error",
  "no-constant-binary-expression": "error",
  "no-self-compare": "error",
  "no-template-curly-in-string": "error",
  "no-unsafe-optional-chaining": "error"
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "server/logs/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["server/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: correctness
  },
  {
    files: ["client/**/*.js", "client/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser }
    },
    rules: correctness
  },
  {
    files: ["eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node }
    }
  }
];
