import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

let application;

async function bootstrap() {
  const [{ createApplication }, { registerProcessLifecycle }] = await Promise.all([
    import("./framework/application/createApplication.js"),
    import("./framework/application/processLifecycle.js")
  ]);

  application = await createApplication();
  registerProcessLifecycle({ application });

  const { url } = await application.start();
  console.log(`API listening on ${url}`);
}

bootstrap().catch(async (error) => {
  console.error(error);

  if (!application) {
    process.exitCode = 1;
    return;
  }

  await application.logger.error(
    "application.startup_failed",
    "API startup failed",
    {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    }
  );

  const result = await application.shutdown("startup_failure", 1);
  process.exitCode = result.exitCode;
});
