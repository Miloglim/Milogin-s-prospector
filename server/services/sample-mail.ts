import type { TokenPort } from '../core/auth';
import { failure } from '../core/crm';
import { validSampleMailUpload } from '../core/sample-mail';
import type { PostgresSampleMailRepository } from '../adapters/postgres/sample-mail-repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSampleMailService(repo: PostgresSampleMailRepository, tokens: TokenPort) {
  return {
    upload(token: string, value: unknown) {
      return validSampleMailUpload(value)
        ? repo.upload(tokens.hash(token), value)
        : Promise.resolve(failure('INVALID_INPUT', '样例邮件参数无效'));
    },
    list(token: string) {
      return repo.list(tokens.hash(token));
    },
    read(token: string, packageId: string) {
      return UUID.test(packageId)
        ? repo.read(tokens.hash(token), packageId)
        : Promise.resolve(failure('INVALID_INPUT', '样例包编号无效'));
    },
    remove(token: string, packageId: string) {
      return UUID.test(packageId)
        ? repo.remove(tokens.hash(token), packageId)
        : Promise.resolve(failure('INVALID_INPUT', '样例包编号无效'));
    },
  };
}

export type SampleMailService = ReturnType<typeof createSampleMailService>;
