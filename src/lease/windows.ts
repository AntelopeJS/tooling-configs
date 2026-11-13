import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { unmarked } from "./env.ts";

/** One live process of the Windows process table. */
export interface WindowsProcess {
  readonly pid: number;
  /** The pid of the process that created it, which may have exited and been reused since. */
  readonly ppid: number;
  /** The creation time as a FILETIME. A pid recorded with it is trusted only while both match. */
  readonly start: string;
  readonly command: string;
  /** Whether its environment holds the marker the table was read for. */
  readonly marked: boolean;
}

/** A process to kill, as it was found. */
export interface WindowsTarget {
  readonly pid: number;
  readonly start: string;
}

const SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AntelopeLease {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr Parent; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Startup { public int cb; public string reserved; public string desktop; public string title; public int x; public int y; public int width; public int height; public int columns; public int rows; public int fill; public int flags; public short show; public short reserved2; public IntPtr reserved3; public IntPtr input; public IntPtr output; public IntPtr error; }
  [StructLayout(LayoutKind.Sequential)]
  struct Created { public IntPtr process; public IntPtr thread; public int pid; public int tid; }

  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, ref Basic info, int size, out int written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr at, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder line, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, int flags, IntPtr env, string cwd, ref Startup startup, out Created created);

  const int TERMINATE = 0x1, READ = 0x10, QUERY = 0x400, LIMITED = 0x1000, SYNCHRONIZE = 0x100000;
  const int DETACHED_PROCESS = 0x8, CREATE_NEW_PROCESS_GROUP = 0x200, INVALID_PARAMETER = 87;
  const int MAX_ENVIRONMENT = 1 << 20;

  static byte[] Read(IntPtr h, long at, int size) {
    var buffer = new byte[size];
    IntPtr read;
    if (at == 0 || !ReadProcessMemory(h, new IntPtr(at), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
    return buffer;
  }

  static long Pointer(IntPtr h, long at) {
    var bytes = Read(h, at, 8);
    return bytes == null ? 0 : BitConverter.ToInt64(bytes, 0);
  }

  static string Text(IntPtr h, long at, long size) {
    if (size <= 0) return "";
    var bytes = Read(h, at, (int)Math.Min(size, MAX_ENVIRONMENT));
    return bytes == null ? "" : Encoding.Unicode.GetString(bytes);
  }

  static long Creation(IntPtr h) {
    long created, exited, kernel, user;
    return GetProcessTimes(h, out created, out exited, out kernel, out user) ? created : 0;
  }

  static string Line(IntPtr h, long parameters) {
    var length = Read(h, parameters + 0x70, 2);
    if (length == null) return "";
    return Text(h, Pointer(h, parameters + 0x78), BitConverter.ToUInt16(length, 0)).Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
  }

  static bool Holds(IntPtr h, long parameters, string marker) {
    if (marker.Length == 0) return false;
    var environment = Text(h, Pointer(h, parameters + 0x80), Pointer(h, parameters + 0x3F0));
    return Array.IndexOf(environment.Split('\0'), marker) >= 0;
  }

  static void Describe(int pid, string marker) {
    IntPtr h = OpenProcess(QUERY | READ | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) return;
    try {
      if (WaitForSingleObject(h, 0) == 0) return;
      var info = new Basic();
      int written;
      if (NtQueryInformationProcess(h, 0, ref info, Marshal.SizeOf(info), out written) != 0) return;
      long parameters = Pointer(h, info.Peb.ToInt64() + 0x20);
      string command = parameters == 0 ? "" : Line(h, parameters);
      bool marked = parameters != 0 && Holds(h, parameters, marker);
      Console.Out.Write(pid + "\t" + info.Parent.ToInt64() + "\t" + Creation(h) + "\t" + (marked ? "1" : "0") + "\t" + command + "\n");
    } finally {
      CloseHandle(h);
    }
  }

  public static void List(string marker) {
    if (IntPtr.Size != 8) throw new PlatformNotSupportedException("antelopejs-lease reads process tables from a 64-bit PowerShell only");
    foreach (var process in Process.GetProcesses()) {
      int pid = process.Id;
      process.Dispose();
      Describe(pid, marker);
    }
  }

  public static void Kill(string targets, int ms) {
    var held = new List<KeyValuePair<int, IntPtr>>();
    foreach (var target in targets.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) {
      var parts = target.Split(':');
      int pid = int.Parse(parts[0]);
      IntPtr h = OpenProcess(TERMINATE | LIMITED | SYNCHRONIZE, false, pid);
      if (h == IntPtr.Zero) {
        if (Marshal.GetLastWin32Error() != INVALID_PARAMETER) Console.Out.Write(pid + "\n");
        continue;
      }
      if (Creation(h).ToString() != parts[1]) {
        CloseHandle(h);
        continue;
      }
      TerminateProcess(h, 1);
      held.Add(new KeyValuePair<int, IntPtr>(pid, h));
    }
    var deadline = DateTime.UtcNow.AddMilliseconds(ms);
    foreach (var pair in held) {
      var left = Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
      if (WaitForSingleObject(pair.Value, (uint)left) != 0) Console.Out.Write(pair.Key + "\n");
      CloseHandle(pair.Value);
    }
  }

  public static void Start(string line) {
    var startup = new Startup();
    startup.cb = Marshal.SizeOf(startup);
    Created created;
    if (!CreateProcessW(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, null, ref startup, out created))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(created.thread);
    CloseHandle(created.process);
    Console.Out.Write(created.pid + "\n");
  }
}
`;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false",
  "$source = $env:ANTELOPEJS_LEASE_WIN_SOURCE",
  "$op = $env:ANTELOPEJS_LEASE_WIN_OP",
  "$arg = $env:ANTELOPEJS_LEASE_WIN_ARG",
  "$wait = [int]$env:ANTELOPEJS_LEASE_WIN_WAIT",
  "$name = Join-Path ([IO.Path]::GetTempPath()) ('antelopejs-lease-' + $env:ANTELOPEJS_LEASE_WIN_HASH)",
  "$dll = $name + '.dll'",
  "Remove-Item Env:ANTELOPEJS_LEASE_WIN_*",
  "if (-not (Test-Path $dll)) { $own = $name + '-' + $PID + '.dll'; Add-Type -TypeDefinition $source -OutputAssembly $own; try { Move-Item $own $dll -ErrorAction Stop } catch { $dll = $own } }",
  "Add-Type -Path $dll",
  "switch ($op) { 'list' { [AntelopeLease]::List($arg) } 'kill' { [AntelopeLease]::Kill($arg, $wait) } 'start' { [AntelopeLease]::Start($arg) } }",
].join("; ");

const HASH = createHash("sha256").update(SOURCE).digest("hex").slice(0, 16);
const TIMEOUT_MS = 120_000;

function powershell(op: string, arg: string, wait = 0): string[] {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const output = execFileSync(
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      SCRIPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...unmarked(process.env),
        ANTELOPEJS_LEASE_WIN_SOURCE: SOURCE,
        ANTELOPEJS_LEASE_WIN_HASH: HASH,
        ANTELOPEJS_LEASE_WIN_OP: op,
        ANTELOPEJS_LEASE_WIN_ARG: arg,
        ANTELOPEJS_LEASE_WIN_WAIT: String(wait),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return output.split(/\r?\n/u).filter(Boolean);
}

function parseProcess(line: string): WindowsProcess[] {
  const [pid, ppid, start, marked, ...command] = line.split("\t");
  if (start === undefined || start === "0") return [];
  return [
    {
      pid: Number(pid),
      ppid: Number(ppid),
      start,
      command: command.join(" ").replace(/\s+/gu, " ").trim(),
      marked: marked === "1",
    },
  ];
}

/**
 * The live processes this user may open and read, with whether the environment of each holds the
 * `marker` entry (`NAME=value`) exactly. Reads each process's environment and command line from
 * its process parameters, as `/proc/<pid>/environ` and `cmdline` give them on Linux.
 */
export function windowsProcesses(marker = ""): WindowsProcess[] {
  return powershell("list", marker).flatMap(parseProcess);
}

/**
 * Terminates each target still running under the start time it was found with, holding its handle
 * from the check to the kill so a reused pid is never reached, and waits up to `ms` for each to
 * exit. Answers the pids still running then.
 */
export function windowsTerminate(
  targets: readonly WindowsTarget[],
  ms: number,
): number[] {
  if (targets.length === 0) return [];
  const list = targets.map((target) => `${target.pid}:${target.start}`);
  return powershell("kill", list.join(","), ms).map(Number);
}

/** `arg` quoted for a Windows command line, read back unchanged by the C runtime's parser. */
function quote(arg: string): string {
  if (arg !== "" && !/[\s"]/u.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1");
  return `"${escaped}"`;
}

/**
 * Starts `file` with `args` as a process that inherits no handle, has no console, and is no child
 * of this process, with this process's environment less the lease marker. Answers its pid.
 */
export function windowsStart(file: string, args: readonly string[]): number {
  const [pid] = powershell("start", [file, ...args].map(quote).join(" "));
  return Number(pid);
}
