import { describe, expect, it } from 'vitest';
import { subtitleFor } from './RegisterPage';

/**
 * The old copy told everyone "the first account on an instance is the admin",
 * which was true of the hosted instance and alarming everywhere else. These
 * pin the three cases apart, because the sentence is the only warning a person
 * setting up an instance gets.
 */
describe('subtitleFor', () => {
  it('says the token is what makes this account the administrator', () => {
    const subtitle = subtitleFor({ firstAccount: true, setupTokenRequired: true });
    expect(subtitle).toMatch(/setup token/i);
  });

  it('warns that the account is the administrator when the instance is open', () => {
    const subtitle = subtitleFor({ firstAccount: true, setupTokenRequired: false });
    expect(subtitle).toMatch(/administrator/i);
    expect(subtitle).not.toMatch(/setup token/i);
  });

  it('claims nothing about administrators on an instance that has accounts', () => {
    const subtitle = subtitleFor({ firstAccount: false, setupTokenRequired: false });
    expect(subtitle).not.toMatch(/administrator/i);
  });

  it('says nothing at all until the instance has answered', () => {
    expect(subtitleFor(undefined)).toBeUndefined();
  });
});
