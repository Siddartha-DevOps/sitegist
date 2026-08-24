import { describe, expect, it } from "vitest";
import { isPrivateOrReservedIp } from "./outbound-url.server";

describe("outbound URL IP policy", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1"])(
    "blocks %s",
    (address) => expect(isPrivateOrReservedIp(address)).toBe(true)
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows %s", (address) =>
    expect(isPrivateOrReservedIp(address)).toBe(false)
  );
});
