import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';

beforeEach(() => {
  delete process.env.CORS_ORIGINS;
});

describe('CORS', () => {
  it('autorise sans header CORS quand pas d\'Origin', async () => {
    process.env.CORS_ORIGINS = 'http://allowed.example';
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
  });

  it('autorise une origine exacte listée', async () => {
    process.env.CORS_ORIGINS = 'http://allowed.example';
    const res = await request(buildApp()).get('/health').set('Origin', 'http://allowed.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://allowed.example');
  });

  it('ne jette PAS 500 quand l\'origine est interdite — répond 200 sans header CORS', async () => {
    process.env.CORS_ORIGINS = 'http://allowed.example';
    const res = await request(buildApp()).get('/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('supporte le wildcard préfixe *.docker.localhost (http et https)', async () => {
    process.env.CORS_ORIGINS = '*.docker.localhost';
    const r1 = await request(buildApp()).get('/health').set('Origin', 'http://idem.docker.localhost');
    expect(r1.headers['access-control-allow-origin']).toBe('http://idem.docker.localhost');
    const r2 = await request(buildApp()).get('/health').set('Origin', 'https://api.idem.docker.localhost');
    expect(r2.headers['access-control-allow-origin']).toBe('https://api.idem.docker.localhost');
  });

  it('supporte le wildcard suffixe chrome-extension://*', async () => {
    process.env.CORS_ORIGINS = 'chrome-extension://*';
    const res = await request(buildApp()).get('/health').set('Origin', 'chrome-extension://abc123');
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://abc123');
  });

  it('avec * tout seul, autorise n\'importe quelle origine', async () => {
    process.env.CORS_ORIGINS = '*';
    const res = await request(buildApp()).get('/health').set('Origin', 'http://random.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
