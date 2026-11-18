import { describe, expect, it } from 'vitest';
import { addressProblem, isPrivateLanIPv4, lanAddresses, parseIPv4, type NetworkInterfaces } from './address.js';

const IFACES: NetworkInterfaces = {
  'Wi-Fi': [
    {
      address: '192.168.1.23',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: null,
    },
    {
      address: 'fe80::1',
      netmask: 'ffff::',
      family: 'IPv6',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: null,
      scopeid: 1,
    },
  ],
  Ethernet: [
    {
      address: '10.0.0.5',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: null,
    },
    {
      address: '203.0.113.9',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: null,
    },
  ],
  'Loopback Pseudo-Interface 1': [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: null,
    },
  ],
};

describe('phone addresses', () => {
  it('parses strict dotted quads only', () => {
    expect(parseIPv4('192.168.1.2')).toEqual([192, 168, 1, 2]);
    for (const bad of ['192.168.1', '192.168.01.2', '256.1.1.1', '1.2.3.4.5', ' 1.2.3.4', '0x7f.0.0.1', '', '::1']) {
      expect(parseIPv4(bad)).toBeNull();
    }
  });

  it('accepts RFC 1918 and link-local, refuses loopback, any, public and the edges of 172.16/12', () => {
    for (const ok of ['10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.0.10', '169.254.3.4']) {
      expect(isPrivateLanIPv4(ok)).toBe(true);
    }
    for (const no of [
      '127.0.0.1',
      '0.0.0.0',
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateLanIPv4(no)).toBe(false);
    }
  });

  it('lists only private IPv4 addresses of non-internal adapters', () => {
    expect(lanAddresses(IFACES)).toEqual([
      { ip: '10.0.0.5', interfaceName: 'Ethernet' },
      { ip: '192.168.1.23', interfaceName: 'Wi-Fi' },
    ]);
  });

  it('refuses 0.0.0.0, loopback, a public address and a private one this computer does not have', () => {
    expect(addressProblem('192.168.1.23', IFACES)).toBeNull();
    expect(addressProblem('0.0.0.0', IFACES)).not.toBeNull();
    expect(addressProblem('127.0.0.1', IFACES)).not.toBeNull();
    expect(addressProblem('203.0.113.9', IFACES)).not.toBeNull();
    expect(addressProblem('192.168.1.99', IFACES)).not.toBeNull();
    expect(addressProblem('not an ip', IFACES)).not.toBeNull();
  });
});
