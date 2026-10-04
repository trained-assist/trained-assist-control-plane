export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier);
    if (!relative) throw error;
    return next(`${specifier}.ts`, context);
  }
}
