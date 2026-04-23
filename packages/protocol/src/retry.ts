function isBlockUnavailable(e: any): boolean {
  const PAT = /(header|block) not found/i;
  return (
    PAT.test(String(e?.message ?? e)) ||
    PAT.test(String(e?.info?.error?.message ?? "")) ||
    PAT.test(String(e?.error?.message ?? ""))
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 5,
  delayMs = 1500,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= retries || !isBlockUnavailable(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
