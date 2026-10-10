import { ulid } from 'ulid';

export * from './attendance';
export * from './i18n';
export * from './money';
export * from './permissions';
export * from './roles';
export * from './user';

/** ULIDs sort by creation time and can be generated offline on a phone without collisions. */
export const newId = (): string => ulid();
