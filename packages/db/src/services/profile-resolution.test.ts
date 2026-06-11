import { describe, expect, it } from 'vitest';
import {
  COOKIE_ID_LENGTH,
  IDENTITY_ID_LENGTH,
  SERVER_HASH_ID_LENGTH,
  isCookieId,
  isIdentityId,
  isResolvableAlias,
  isServerHashId,
} from './profile-resolution';

// Representative real ids from prod:
const UID = 'O967II8LSZ'; // 10-char Newton uid (identified)
const COOKIE = '1bc69db88febfa2d'; // 16-char op_device_id cookie (anon)
const SERVER_HASH = 'ab2224e76b211bc12e832407df66270d'; // 32-char IP+UA hash (anon)

describe('profile-resolution id classification', () => {
  it('has the expected id lengths', () => {
    expect(UID).toHaveLength(IDENTITY_ID_LENGTH);
    expect(COOKIE).toHaveLength(COOKIE_ID_LENGTH);
    expect(SERVER_HASH).toHaveLength(SERVER_HASH_ID_LENGTH);
  });

  it('classifies a uid as identity only', () => {
    expect(isIdentityId(UID)).toBe(true);
    expect(isCookieId(UID)).toBe(false);
    expect(isServerHashId(UID)).toBe(false);
  });

  it('classifies a cookie as cookie only', () => {
    expect(isCookieId(COOKIE)).toBe(true);
    expect(isIdentityId(COOKIE)).toBe(false);
    expect(isServerHashId(COOKIE)).toBe(false);
  });

  it('classifies a server hash as hash only', () => {
    expect(isServerHashId(SERVER_HASH)).toBe(true);
    expect(isIdentityId(SERVER_HASH)).toBe(false);
    expect(isCookieId(SERVER_HASH)).toBe(false);
  });

  describe('isResolvableAlias — the core safety gate', () => {
    it('resolves ONLY the 16-char cookie', () => {
      expect(isResolvableAlias(COOKIE)).toBe(true);
    });

    it('never resolves the 32-char IP+UA hash (would re-merge users)', () => {
      expect(isResolvableAlias(SERVER_HASH)).toBe(false);
    });

    it('never resolves a uid or empty id', () => {
      expect(isResolvableAlias(UID)).toBe(false);
      expect(isResolvableAlias('')).toBe(false);
    });
  });
});
