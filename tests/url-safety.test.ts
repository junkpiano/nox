import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicWebUrl } from '../src/common/url-safety.js';

test('url safety: public sites are fetched', () => {
  for (const url of [
    'https://example.com/page',
    'http://news.example.co.jp/a?b=c',
    'https://8.8.8.8/',
    'https://[2606:4700::1111]/',
    'https://xn--wgv71a.jp/',
  ]) {
    assert.equal(isPublicWebUrl(url), true, url);
  }
});

test('url safety: the loopback, private ranges and link-local are not', () => {
  for (const url of [
    'http://localhost/',
    'http://LOCALHOST:8080/',
    'http://foo.localhost/',
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://10.0.0.5/admin',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:192.168.0.1]/',
  ]) {
    assert.equal(isPublicWebUrl(url), false, url);
  }
});

test('url safety: names that only mean something on the local network, and odd spellings', () => {
  for (const url of [
    'http://nas/',
    'http://router.local/',
    'http://db.internal/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://172.16.0.1./',
  ]) {
    assert.equal(isPublicWebUrl(url), false, url);
  }
});

test('url safety: only http(s), and no credentials in the address', () => {
  for (const url of [
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pw@example.com/',
    'not a url',
  ]) {
    assert.equal(isPublicWebUrl(url), false, url);
  }
});
