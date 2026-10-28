const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Exits with a stopped page server unless app.relaunch() produced a replacement Electron process. */
export async function preserveServerForRelaunch({ probe, stop, graceMs, probeIntervalMs }) {
  const deadline = Date.now() + graceMs;
  while (true) {
    if (probe()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(probeIntervalMs, remaining));
  }
  await stop();
  return false;
}
