import path from "node:path";

export function requireMercurServerModule<T>(
  packageName: string,
  ...segments: string[]
): T {
  let packageRoot: string;

  try {
    packageRoot = path.dirname(
      require.resolve(`@mercurjs/${packageName}/package.json`)
    );
  } catch (err) {
    throw new Error(
      `Mercur package @mercurjs/${packageName} not found. Ensure it is installed in node_modules. Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const modulePath = path.join(
    packageRoot,
    ".medusa",
    "server",
    "src",
    ...segments
  );

  try {
    return require(modulePath) as T;
  } catch (err) {
    throw new Error(
      `Failed to load @mercurjs/${packageName}/${segments.join("/")}. Path: ${modulePath}. Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}