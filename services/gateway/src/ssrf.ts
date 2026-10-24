// SSRF protection for upstream URLs.
//
// An admin types a URL and the GATEWAY connects to it, from inside the cluster. Without checks, a malicious or
// careless URL could make the gateway call things it can reach but the admin shouldn't:
//   - http://169.254.169.254/...      the cloud metadata service (hands out cloud credentials)
//   - http://urumi-postgres:5432      our own database, or any other internal Service
//   - http://localhost:...            the gateway Pod itself
// So every upstream URL must resolve to a PUBLIC address, unless its host is on an explicit allow-list of
// in-cluster MCP servers (our woo-mcp and everything-mcp). Checked when a server is saved AND before every
// connection, so a DNS name that later starts pointing inside is still caught.
//
// Second layer (in Kubernetes, not here): the gateway's NetworkPolicy blocks private ranges and 169.254.0.0/16
// on egress, so even a check we missed (or a redirect) can't reach them.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { config } from "./config.js";

const blocked = new net.BlockList();
for (const [range, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["64:ff9b::", 96]] as const) {
  blocked.addSubnet(range, bits, "ipv6");
}

function isBlocked(address: string): boolean {
  // IPv4 written as IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it really is.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

/** Returns null if the URL is acceptable, otherwise a sentence explaining why not. */
export async function checkUpstreamUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https URLs are allowed";
  if (url.username || url.password) return "put credentials in the credential field, not in the URL";

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (config.allowedInternalHosts.includes(host)) return null; // known in-cluster MCP server

  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return `the host "${host}" could not be resolved`;
  }
  const internal = addresses.find(isBlocked);
  if (internal) {
    return `"${host}" points to ${internal}, a private or internal address. Only allow-listed in-cluster hosts may use those (${config.allowedInternalHosts.join(", ") || "none"}).`;
  }
  return null;
}
