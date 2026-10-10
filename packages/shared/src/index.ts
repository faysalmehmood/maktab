import { ulid } from 'ulid';

export * from './academic';
export * from './attendance';
export * from './csv';
export * from './dto';
export * from './fees';
export * from './i18n';
export * from './import';
export * from './money';
export * from './permissions';
export * from './phone';
export * from './roles';
export * from './user';

/** ULIDs sort by creation time and can be generated offline on a phone without collisions. */
export const newId = (): string => ulid();
export * from './i18n-fees';
