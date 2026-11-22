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

test('url safety: IPv6 ranges that carry or stand for a private network are refused', () => {
  for (const url of [
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::192.168.1.1]/',
    'http://[fec0::1]/',
    'http://[fe9f::1]/',
    'http://[fc00::1]/',
    'http://[ff02::1]/',
    'http://[64:ff9b::192.168.1.1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[64:ff9b:1::1]/',
    'http://[2002:c0a8:101::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2001::1]/',
    'http://[2001:db8::1]/',
    'http://[100::1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[::ffff:0:c0a8:101]/',
    'http://[2001:2::1]/',
    'http://[2001:10::1]/',
    'http://[2001:20::1]/',
    'http://[3fff::1]/',
    'http://[5f00::1]/',
  ]) {
    assert.equal(isPublicWebUrl(url), false, url);
  }
});

test('url safety: public IPv6 addresses, including NAT64 and 6to4 of a public IPv4, are allowed', () => {
  for (const url of [
    'https://[2606:4700::1111]/',
    'https://[2a00:1450:4001:80b::200e]/',
    'https://[64:ff9b::808:808]/',
    'https://[2002:808:808::1]/',
    'https://[::ffff:8.8.8.8]/',
    'https://[3ff0::1]/',
    'https://[3fff:1000::1]/',
  ]) {
    assert.equal(isPublicWebUrl(url), true, url);
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
