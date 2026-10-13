import { ulid } from 'ulid';

export * from './academic';
export * from './alloc';
export * from './attendance';
export * from './backup';
export * from './csv';
export * from './dto';
export * from './fees';
export * from './i18n';
export * from './import';
export * from './messaging';
export * from './money';
export * from './moneyout';
export * from './permissions';
export * from './phone';
export * from './roles';
export * from './user';

/** ULIDs sort by creation time and can be generated offline on a phone without collisions. */
export const newId = (): string => ulid();
export * from './i18n-fees';
export * from './i18n-messages';
export * from './i18n-money';
