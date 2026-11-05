import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";

import { eachRole, PORT_ROLES, type LeaseId, type Ports } from "./protocol.ts";

const BAND_START = 20010;
const BAND_END = 30000;
const BLOCK_SIZE = 10;
const BLOCK_COUNT = (BAND_END - BAND_START) / BLOCK_SIZE;
const DENIED_PORTS = [24678, 27017, 27018, 27019];
const CONNECT_TIMEOUT_MS = 1_000;
const LISTEN_STATE = "0A";

/**
 * The block bases a lease tries, in order: from a block picked by a hash of the id and `uid`
 * together, forward and around the band. Each user keeps a registry of its own, so mixing in the
 * uid usually starts two users' worktrees at one path on different blocks. The band [20010, 30000)
 * sits below the kernel's ephemeral range (32768 and up on Linux, 49152 and up on macOS), so no
 * `bind(:0)` caller races for these ports. Blocks holding the Vite HMR default (24678) or a system
 * mongod (27017 to 27019) are skipped.
 */
export function candidateBases(
  id: LeaseId,
  uid: number = process.getuid?.() ?? 0,
): number[] {
  const first =
    createHash("sha256").update(`${uid}:${id}`).digest().readUInt32BE(0) %
    BLOCK_COUNT;
  return Array.from(
    { length: BLOCK_COUNT },
    (_, step) => BAND_START + ((first + step) % BLOCK_COUNT) * BLOCK_SIZE,
  ).filter(
    (base) =>
      !DENIED_PORTS.some((port) => port >= base && port < base + BLOCK_SIZE),
  );
}

function blockPorts(base: number): number[] {
  return Array.from({ length: BLOCK_SIZE }, (_, offset) => base + offset);
}

async function everyBindable(
  ports: readonly number[],
  bindable: (port: number) => Promise<boolean>,
): Promise<boolean> {
  for (const port of ports) if (!(await bindable(port))) return false;
  return true;
}

/**
 * The first candidate block none of whose ten ports is in `taken` and all of whose ports bind.
 * Throws when the band has no such block.
 */
export async function chooseBlock(
  id: LeaseId,
  taken: ReadonlySet<number>,
  bindable: (port: number) => Promise<boolean>,
): Promise<Ports> {
  for (const base of candidateBases(id)) {
    const ports = blockPorts(base);
    if (ports.some((port) => taken.has(port))) continue;
    if (await everyBindable(ports, bindable))
      return eachRole((role) => base + PORT_ROLES[role]);
  }
  throw new Error(
    `antelopejs-lease: no free port block in ${BAND_START}-${BAND_END - 1}; run antelopejs-lease gc, then retry`,
  );
}

/** Listens on `host:port`, Node's dual-stack default without `host`. `undefined` when the address is in use. */
export function claimPort(
  port: number,
  host?: string,
): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(error);
    });
    server.listen({ port, host }, () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function bindsOn(port: number, host?: string): Promise<boolean> {
  try {
    const server = await claimPort(port, host);
    if (server === undefined) return false;
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when nothing holds `port`. The dual-stack wildcard bind fails on Linux for a listener on any
 * local address; the 127.0.0.1 bind covers systems that let a wildcard sit beside a specific address.
 */
export async function bindable(port: number): Promise<boolean> {
  return (await bindsOn(port, "127.0.0.1")) && bindsOn(port);
}

function acceptsOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host, timeout: CONNECT_TIMEOUT_MS });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** True when a server accepts connections on `port` on the IPv4 or the IPv6 loopback. */
export async function accepting(port: number): Promise<boolean> {
  return (await acceptsOn(port, "127.0.0.1")) || acceptsOn(port, "::1");
}

function listenInodes(table: string, port: number): string[] {
  let text: string;
  try {
    text = readFileSync(table, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(
      (columns) =>
        columns[3] === LISTEN_STATE &&
        Number.parseInt(columns[1]?.split(":")[1] ?? "", 16) === port,
    )
    .map((columns) => `socket:[${columns[9]}]`);
}

function holdsSocket(pid: string, sockets: ReadonlySet<string>): boolean {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  return fds.some((fd) => {
    try {
      return sockets.has(readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch {
      return false;
    }
  });
}

function listenSockets(port: number): Set<string> {
  return new Set([
    ...listenInodes("/proc/net/tcp", port),
    ...listenInodes("/proc/net/tcp6", port),
  ]);
}

function linuxListenerPids(port: number): number[] {
  const sockets = listenSockets(port);
  if (sockets.size === 0) return [];
  return readdirSync("/proc")
    .filter((name) => /^\d+$/u.test(name) && holdsSocket(name, sockets))
    .map(Number);
}

function lsofListenerPids(port: number): number[] {
  try {
    return execFileSync(
      "lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter((line) => /^\d+$/u.test(line))
      .map(Number);
  } catch {
    return [];
  }
}

/** The pids listening on `port` that this user may inspect; empty when none can be read. */
export function listenerPids(port: number): number[] {
  if (process.platform === "linux") return linuxListenerPids(port);
  if (process.platform === "darwin") return lsofListenerPids(port);
  return [];
}

/**
 * True when process `pid` listens on `port`. Where the platform gives no way to tell, true when
 * anything accepts on `port`.
 */
export async function listensOn(pid: number, port: number): Promise<boolean> {
  if (process.platform === "linux")
    return holdsSocket(String(pid), listenSockets(port));
  if (process.platform === "darwin")
    return lsofListenerPids(port).includes(pid);
  return accepting(port);
}
