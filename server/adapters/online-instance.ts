import { randomBytes } from 'node:crypto';

const INSTANCE_ID_PATTERN = /^[a-f0-9]{64}$/;

export function resolveOnlineInstanceId(
  env: NodeJS.ProcessEnv = process.env,
  generate: () => string = () => randomBytes(32).toString('hex'),
): string {
  const configured = env.PROSPECTOR_ONLINE_INSTANCE?.trim();
  if (configured) {
    if (!INSTANCE_ID_PATTERN.test(configured)) throw new Error('本节点启动标识无效');
    return configured;
  }
  const generated = generate();
  if (!INSTANCE_ID_PATTERN.test(generated)) throw new Error('本节点启动标识生成失败');
  return generated;
}
