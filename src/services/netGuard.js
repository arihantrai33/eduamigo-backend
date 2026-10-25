// Stops a configurable network target (an SMTP host) from pointing at the server's own network.
// The host name is resolved here, every address is checked, and the caller connects to the checked address, so a name that
// resolves differently a moment later cannot slip through (DNS rebinding). ALLOW_PRIVATE_SMTP_HOSTS=true switches the check off
// for local development against a mail catcher; it is not for production.
const dns = require('dns').promises;
const net = require('net');

// Node's BlockList understands IPv4, IPv6 and IPv4-mapped IPv6 (::ffff:7f00:1 as well as ::ffff:127.0.0.1), so no spelling of a
// loopback, private, link-local, carrier-grade NAT, documentation, multicast or reserved address gets through.
const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, bits, 'ipv6');
const isPrivateAddress = (ip) => {
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!family) return true;
  if (family === 'ipv6') { // a mapped IPv4 address is judged as the IPv4 address it wraps
    const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
    if (m) {
      const v4 = m[1] || [parseInt(m[2], 16) >> 8, parseInt(m[2], 16) & 255, parseInt(m[3], 16) >> 8, parseInt(m[3], 16) & 255].join('.');
      return blocked.check(v4, 'ipv4');
    }
  }
  return blocked.check(ip, family);
};

const allowPrivate = () => process.env.ALLOW_PRIVATE_SMTP_HOSTS === 'true';

// -> the address to connect to. Throws { code: 'EBLOCKED' | 'EDNS' }.
async function resolvePublicHost(host) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw fail('EDNS', 'The mail server name could not be found'); }
  }
  if (!addresses.length) throw fail('EDNS', 'The mail server name could not be found');
  if (!allowPrivate() && addresses.some(isPrivateAddress)) throw fail('EBLOCKED', 'This address points to a private or internal network and is not allowed');
  return addresses[0];
}

module.exports = { resolvePublicHost, isPrivateAddress };
