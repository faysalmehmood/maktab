import type { SchoolIdentityDto, SchoolResponse } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { fakeR2, signedInAs, testApp } from './helpers';

// M7b (UI plan §6): school identity fields, and the public identity source for the sign-in page.

async function setup() {
  const r2 = fakeR2();
  const t = testApp({ env: { FILES: r2.bucket } });
  const owner = await signedInAs(t.db, ['owner']);
  const put = async (body: Record<string, unknown>) => {
    const res = await t.request('/api/school', {
      method: 'PUT',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'school', ...body }),
    });
    return { status: res.status, body: (await res.json()) as SchoolResponse };
  };
  const identity = async () => {
    const res = await t.request('/api/identity');
    return { res, body: (await res.json()) as SchoolIdentityDto };
  };
  return { ...t, r2, owner, put, identity };
}

describe('M7b school identity', () => {
  it('saves short name (upper-cased), city and a curated colour; omitted keeps, null clears', async () => {
    const f = await setup();
    const a = await f.put({
      name: 'Global Science Academy',
      short_name: 'gsa',
      city: 'Pakpattan',
      brand_color: 'blue',
    });
    expect(a.status).toBe(200);
    expect(a.body.school).toMatchObject({
      short_name: 'GSA',
      city: 'Pakpattan',
      brand_color: 'blue',
    });
    // An older client that does not send the identity fields does not blank them.
    const b = await f.put({ name: 'Global Science Academy', phone: '0457 123456' });
    expect(b.body.school).toMatchObject({
      short_name: 'GSA',
      city: 'Pakpattan',
      brand_color: 'blue',
    });
    const c = await f.put({ name: 'Global Science Academy', short_name: '', city: null });
    expect(c.body.school).toMatchObject({ short_name: null, city: null, brand_color: 'blue' });
  });

  it('refuses a colour outside the curated set and a short name that is not 1–4 letters/digits', async () => {
    const f = await setup();
    expect((await f.put({ name: 'X', brand_color: '#ff0000' })).status).toBe(400);
    expect((await f.put({ name: 'X', short_name: 'TOOLONG' })).status).toBe(400);
    expect((await f.put({ name: 'X', short_name: 'G<S' })).status).toBe(400);
    expect((await f.put({ name: 'X', short_name: 'AB12' })).status).toBe(200);
  });

  it('GET /api/identity: public, a whitelist, null before setup', async () => {
    const f = await setup();
    expect((await f.identity()).body).toEqual({ school: null });
    await f.put({
      name: 'Global Science Academy',
      name_ur: 'گلوبل سائنس اکیڈمی',
      short_name: 'GSA',
      city: 'Pakpattan',
      brand_color: 'blue',
      address: 'Secret Street 1',
      phone: '0457 123456',
      receipt_prefix: 'GSA',
    });
    const { res, body } = await f.identity();
    expect(res.status).toBe(200);
    expect(Object.keys(body.school ?? {}).sort()).toEqual(
      ['brand_color', 'city', 'logo_v', 'name', 'name_ur', 'phone', 'short_name'].sort(),
    );
    expect(body.school).toMatchObject({ name: 'Global Science Academy', logo_v: null });
    expect(JSON.stringify(body)).not.toContain('Secret Street');
  });

  it('GET /api/identity/logo: public image with a version, 404 without a logo, image types only', async () => {
    const f = await setup();
    await f.put({ name: 'Al-Noor Community School' });
    expect((await f.request('/api/identity/logo')).status).toBe(404);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await f.r2.bucket.put('school/logo-1', png, { httpMetadata: { contentType: 'image/png' } });
    await f.db.run(sql`UPDATE school SET logo_key = 'school/logo-1'`);
    const v = (await f.identity()).body.school?.logo_v;
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    const logo = await f.request(`/api/identity/logo?v=${v}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(png);
    await f.r2.bucket.put('school/logo-1', png, { httpMetadata: { contentType: 'text/html' } });
    expect((await f.request('/api/identity/logo')).status).toBe(404);
  });
});
