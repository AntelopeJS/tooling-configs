import { type AddressInfo, createServer, type Server } from "node:net";

const PORT_LOW = 10_000;
const PORT_HIGH = 20_000;
const PORT_ATTEMPTS = 50;

function isAddressInfo(
  address: ReturnType<Server["address"]>,
): address is AddressInfo {
  return address instanceof Object;
}

function bindable(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = isAddressInfo(address) ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

const handedOut = new Set<number>();

async function claim(port: number): Promise<number | null> {
  if (handedOut.has(port)) return null;
  handedOut.add(port);
  if ((await bindable(port)) !== null) return port;
  handedOut.delete(port);
  return null;
}

async function claimKernelPort(): Promise<number | null> {
  const bound = await bindable(0);
  if (bound === null || handedOut.has(bound)) return null;
  handedOut.add(bound);
  return bound;
}

/**
 * A free TCP port on the loopback interface for a stub server a test starts next, never returned twice in this process.
 * It tries random ports below the kernel's ephemeral range first, where no outgoing connection takes it between this
 * check and the server's own bind, then falls back to a port the kernel picks.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const claimed = await claim(
      PORT_LOW + Math.floor(Math.random() * (PORT_HIGH - PORT_LOW)),
    );
    if (claimed !== null) return claimed;
  }
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const claimed = await claimKernelPort();
    if (claimed !== null) return claimed;
  }
  throw new Error("no free loopback port");
}
